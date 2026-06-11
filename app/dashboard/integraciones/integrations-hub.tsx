"use client";

import Link from "next/link";
import { useCallback, useRef, useState, useTransition } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import DeviceOperationsConsole from "./device-operations-console";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  activo: boolean;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

type EqualitySummary = {
  configured: boolean;
  canManage: boolean;
  deviceUid: string;
  probe: boolean;
  resultCode: string | null;
  resultMessage: string | null;
  remoteStatusCode: number | null;
};

type FirmaSeguroDiagnostic = {
  configured: boolean;
  authorized?: boolean;
  providerStatus?: number | null;
  baseHost: string;
  authMode: string;
  authSource?: string;
  tokenShape?: string;
  accessTokenConfigured: boolean;
  emailConfigured: boolean;
  passwordConfigured: boolean;
  nitConfigured: boolean;
  nit: string | null;
  useCompanyEndpoint: boolean;
  callbackConfigured: boolean;
  processTypeId?: number;
  signatureMethodId?: number;
  authMethodId?: number;
  balanceTypeId?: number;
  balanceChecked?: boolean;
  balanceOk?: boolean;
  balanceMessage?: string;
  balance?: unknown;
  balanceError?: unknown;
  signatureTypesOk?: boolean;
  signatureTypes?: unknown;
  signatureTypesError?: unknown;
  authenticationTypesOk?: boolean;
  authenticationTypes?: unknown;
  authenticationTypesError?: unknown;
};

type ApiResult<T> = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  data: T | null;
  error: string | null;
};

type Snapshot = {
  equality: ApiResult<EqualitySummary>;
  loadedAt: string;
  source: string;
};

type StatusTone = "amber" | "emerald" | "red" | "slate";

type StatusMeta = {
  detail: string;
  label: string;
  tone: StatusTone;
};

const EXTERNAL_CREDIT_API_URL =
  "https://finserpay.com/api/integraciones/creditos/imei?imei=350792390007233";
const EXTERNAL_CREDIT_API_CURL = `curl "${EXTERNAL_CREDIT_API_URL}" \\
  -H "Authorization: Bearer TU_LLAVE_DE_API"`;

function formatTime(value?: string | null) {
  if (!value) {
    return "Sin lectura";
  }

  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDiagnosticPayload(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "Sin lectura";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "No se pudo mostrar la respuesta";
  }
}

async function fetchJson<T>(url: string): Promise<ApiResult<T>> {
  const startedAt =
    typeof performance === "undefined" ? Date.now() : performance.now();

  try {
    const response = await fetch(url, {
      cache: "no-store",
    });

    const data = (await response.json().catch(() => null)) as
      | (T & { error?: string; message?: string })
      | null;

    const endedAt =
      typeof performance === "undefined" ? Date.now() : performance.now();
    const latencyMs = Math.max(1, Math.round(endedAt - startedAt));

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        data: data as T,
        error:
          (data &&
            typeof data === "object" &&
            (data.error || data.message || null)) ||
          `Error ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      latencyMs,
      data: data as T,
      error: null,
    };
  } catch (error) {
    const endedAt =
      typeof performance === "undefined" ? Date.now() : performance.now();

    return {
      ok: false,
      status: null,
      latencyMs: Math.max(1, Math.round(endedAt - startedAt)),
      data: null,
      error:
        error instanceof Error ? error.message : "No se pudo consultar Zero Touch",
    };
  }
}

function resolveZeroTouchStatus(
  result?: ApiResult<EqualitySummary> | null
): StatusMeta {
  if (!result) {
    return {
      label: "Revisando",
      tone: "slate",
      detail: "Estamos comprobando si la conexion esta lista.",
    };
  }

  if (!result.ok) {
    return {
      label: "Requiere revision",
      tone: "red",
      detail: result.error || "No se pudo consultar el estado.",
    };
  }

  if (!result.data?.configured) {
    return {
      label: "Falta configurar",
      tone: "amber",
      detail: "Aun falta conectar la llave de Zero Touch.",
    };
  }

  const code = String(result.data.resultCode || "").toUpperCase();

  if (code.includes("PENDING")) {
    return {
      label: "En proceso",
      tone: "amber",
      detail: "La conexion responde, pero aun esta terminando de quedar lista.",
    };
  }

  return {
    label: "Conectado",
    tone: "emerald",
    detail: result.data.canManage
      ? "Puedes consultar, inscribir y validar equipos."
      : "Puedes consultar equipos. Las acciones remotas requieren permisos.",
  };
}

function resolveFirmaSeguroStatus(
  result?: ApiResult<FirmaSeguroDiagnostic> | null
): StatusMeta {
  if (!result) {
    return {
      label: "Sin probar",
      tone: "slate",
      detail: "Ejecuta una prueba para validar el token guardado en Railway.",
    };
  }

  if (!result.ok) {
    return {
      label: result.status === 401 ? "Token rechazado" : "Requiere revision",
      tone: "red",
      detail: result.error || "FirmaSeguro no autorizo la prueba.",
    };
  }

  if (!result.data?.configured) {
    return {
      label: "Falta configurar",
      tone: "amber",
      detail: "Falta token, usuario o clave de FirmaSeguro.",
    };
  }

  if (result.data.authorized) {
    return {
      label: "Autorizado",
      tone: "emerald",
      detail: result.data.balanceChecked
        ? "El token respondio contra FirmaSeguro."
        : "El token es valido, pero falta NIT para consultar balance.",
    };
  }

  return {
    label: "No autorizado",
    tone: "red",
    detail: "FirmaSeguro rechazo la autenticacion.",
  };
}

function statusClasses(tone: StatusTone) {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "red":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function CopyButton({
  label,
  onCopy,
  value,
}: {
  label: string;
  onCopy: (value: string, label: string) => void;
  value: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(value, label)}
      className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-slate-700 transition hover:border-[#116b61] hover:text-slate-950"
    >
      Copiar {label}
    </button>
  );
}

export default function IntegrationsHub({
  initialSession,
}: {
  initialSession: SessionUser;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [firmaSeguroResult, setFirmaSeguroResult] =
    useState<ApiResult<FirmaSeguroDiagnostic> | null>(null);
  const [firmaSeguroLoading, setFirmaSeguroLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const requestRef = useRef<Promise<void> | null>(null);

  const loadSnapshot = useCallback(
    async (source = "manual") => {
      if (requestRef.current) {
        return requestRef.current;
      }

      const currentRequest = (async () => {
        try {
          setMessage("");
          const equality = await fetchJson<EqualitySummary>("/api/equality?probe=1");

          startTransition(() => {
            setSnapshot({
              equality,
              loadedAt: new Date().toISOString(),
              source,
            });
          });
        } catch (error) {
          setMessage(
            error instanceof Error
              ? error.message
              : "No se pudo actualizar la pantalla"
          );
        } finally {
          setLoading(false);
          requestRef.current = null;
        }
      })();

      requestRef.current = currentRequest;
      return currentRequest;
    },
    [startTransition]
  );

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label} copiado.`);
      window.setTimeout(() => setCopyMessage(""), 2500);
    } catch {
      setCopyMessage("No se pudo copiar automaticamente.");
      window.setTimeout(() => setCopyMessage(""), 2500);
    }
  }, []);

  const runFirmaSeguroDiagnostic = useCallback(async () => {
    setFirmaSeguroLoading(true);
    setMessage("");

    try {
      const result = await fetchJson<FirmaSeguroDiagnostic>(
        "/api/firma-seguro/diagnostico"
      );
      setFirmaSeguroResult(result);
    } finally {
      setFirmaSeguroLoading(false);
    }
  }, []);

  useLiveRefresh(
    async () => {
      await loadSnapshot("automatico");
    },
    {
      enabled: true,
      intervalMs: 20000,
      runOnMount: true,
    }
  );

  const status = resolveZeroTouchStatus(snapshot?.equality);
  const canAdmin = String(initialSession.rolNombre || "").toUpperCase() === "ADMIN";
  const firmaSeguroStatus = resolveFirmaSeguroStatus(firmaSeguroResult);
  const firmaSeguroDiagnostic = firmaSeguroResult?.data;
  const busy = loading || isPending;

  return (
    <div className="min-h-screen bg-[#f6f7f3] px-4 py-6 text-slate-950">
      <main className="mx-auto max-w-5xl">
        <section className="rounded-[32px] border border-[#e1d8ca] bg-white px-5 py-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">
                Control de equipos
              </span>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Consulta, inscribe y valida
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Una pantalla simple para saber si el equipo puede entregarse.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void loadSnapshot("manual")}
                disabled={busy}
                className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-800 transition hover:border-[#116b61] disabled:opacity-70"
              >
                {busy ? "Actualizando..." : "Actualizar"}
              </button>

              <Link
                href="/dashboard"
                className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white transition hover:bg-slate-800"
              >
                Dashboard
              </Link>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
            <div className={["rounded-[22px] border px-4 py-4", statusClasses(status.tone)].join(" ")}>
              <p className="text-[11px] font-black uppercase tracking-[0.18em]">
                Estado Zero Touch
              </p>
              <p className="mt-2 text-xl font-black">{status.label}</p>
              <p className="mt-1 text-sm leading-6">{status.detail}</p>
            </div>

            <div className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                Ultima lectura
              </p>
              <p className="mt-2 text-lg font-black text-slate-950">
                {formatTime(snapshot?.loadedAt || null)}
              </p>
              <p className="mt-1 text-xs">
                {snapshot?.source === "automatico" ? "Automatico" : "Manual"}
              </p>
            </div>
          </div>

          {canAdmin && (
            <div className="mt-5 rounded-[26px] border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                    FirmaSeguro
                  </p>
                  <div
                    className={[
                      "mt-3 inline-flex rounded-full border px-3 py-1 text-xs font-black",
                      statusClasses(firmaSeguroStatus.tone),
                    ].join(" ")}
                  >
                    {firmaSeguroStatus.label}
                  </div>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                    {firmaSeguroStatus.detail}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => void runFirmaSeguroDiagnostic()}
                  disabled={firmaSeguroLoading}
                  className="rounded-2xl bg-[#116b61] px-5 py-3 text-sm font-black text-white transition hover:bg-[#0d5750] disabled:opacity-70"
                >
                  {firmaSeguroLoading ? "Probando..." : "Probar token"}
                </button>
              </div>

              {firmaSeguroDiagnostic && (
                <div className="mt-4 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Host
                      </p>
                      <p className="mt-1 break-all text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.baseHost || "Sin host"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Auth
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.authSource ||
                          firmaSeguroDiagnostic.authMode ||
                          "Sin lectura"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        NIT
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.nit || "No configurado"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Respuesta
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroResult?.status
                          ? `HTTP ${firmaSeguroResult.status}`
                          : "Sin prueba"}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Proceso
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.processTypeId ?? "Sin ID"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Firma
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.signatureMethodId ?? "Sin ID"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Autenticacion
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.authMethodId ?? "Sin ID"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white bg-white px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Balance type
                      </p>
                      <p className="mt-1 text-sm font-black text-slate-800">
                        {firmaSeguroDiagnostic.balanceTypeId ?? "Sin ID"}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-3">
                    {[
                      {
                        label: "Balance",
                        value:
                          firmaSeguroDiagnostic.balance ??
                          firmaSeguroDiagnostic.balanceError ??
                          firmaSeguroDiagnostic.balanceMessage,
                      },
                      {
                        label: "Tipos de firma",
                        value:
                          firmaSeguroDiagnostic.signatureTypes ??
                          firmaSeguroDiagnostic.signatureTypesError,
                      },
                      {
                        label: "Tipos autenticacion",
                        value:
                          firmaSeguroDiagnostic.authenticationTypes ??
                          firmaSeguroDiagnostic.authenticationTypesError,
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="rounded-2xl border border-white bg-white px-4 py-3"
                      >
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                          {item.label}
                        </p>
                        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">
                          {formatDiagnosticPayload(item.value)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {message && (
          <div className="mt-5 rounded-[22px] border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-700">
            {message}
          </div>
        )}

        {copyMessage && (
          <div className="mt-5 rounded-[22px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm font-bold text-emerald-700">
            {copyMessage}
          </div>
        )}

        <DeviceOperationsConsole canAdmin={canAdmin} />

        {canAdmin && (
          <details className="mt-6 rounded-[28px] border border-[#e1d8ca] bg-white px-5 py-4 shadow-[0_14px_45px_rgba(15,23,42,0.05)]">
            <summary className="cursor-pointer text-sm font-black uppercase tracking-[0.14em] text-slate-700">
              API para comercios
            </summary>
            <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_0.8fr]">
              <div className="rounded-[22px] border border-slate-200 bg-slate-50 p-4">
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                  Consulta por IMEI
                </p>
                <p className="mt-2 break-all font-mono text-xs text-slate-800">
                  {EXTERNAL_CREDIT_API_URL}
                </p>
                <div className="mt-4">
                  <CopyButton
                    label="URL"
                    value={EXTERNAL_CREDIT_API_URL}
                    onCopy={copyText}
                  />
                </div>
              </div>

              <div className="rounded-[22px] border border-slate-200 bg-slate-950 p-4 text-slate-100">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-300">
                    Ejemplo
                  </p>
                  <CopyButton
                    label="cURL"
                    value={EXTERNAL_CREDIT_API_CURL}
                    onCopy={copyText}
                  />
                </div>
                <pre className="mt-3 overflow-x-auto text-xs leading-6">
                  {EXTERNAL_CREDIT_API_CURL}
                </pre>
              </div>
            </div>
          </details>
        )}
      </main>
    </div>
  );
}
