"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import FinserBrand from "@/app/_components/finser-brand";

type EqualityResponse = {
  configured: boolean;
  canManage: boolean;
  deviceUid: string;
  deviceSnapshot: {
    createdTimeStamp: string | null;
    deviceManufacturer: string | null;
    deviceMarketName: string | null;
    deviceModel: string | null;
    deviceUid: string | null;
    lastChanged: string | null;
    lastCheckIn: string | null;
    serviceDetails: string | null;
    stateInfo: string | null;
    tenantName: string | null;
    transitionQueue: string[];
    transitionState: string | null;
  } | null;
  deviceState: string | null;
  deliveryStatus: {
    detail: string;
    label: string;
    ready: boolean;
    tone: "amber" | "emerald" | "red" | "sky" | "slate";
  } | null;
  probe: boolean;
  response: Record<string, unknown> | null;
  resultCode: string | null;
  resultMessage: string | null;
  remoteStatusCode: number | null;
  serviceDetails: string | null;
};

type EqualityAction =
  | "enroll"
  | "lock"
  | "query"
  | "release"
  | "unlock";

type DeliveryTone = "amber" | "emerald" | "red" | "sky" | "slate";

type NoticeTone = "amber" | "emerald" | "red" | "slate";

type ConsoleNotice = {
  text: string;
  tone: NoticeTone;
};

const dashboardVars = {
  "--zt-bg": "#f4efe7",
  "--zt-card": "#fffdfa",
  "--zt-ink": "#102136",
  "--zt-line": "#e5dac9",
  "--zt-night": "#12161d",
  "--zt-muted": "#5f6f81",
  "--zt-gold": "#c79a57",
} as CSSProperties;

function formatoFecha(valor: string | null) {
  if (!valor) {
    return "-";
  }

  return new Date(valor).toLocaleString("es-CO");
}

function sanitizeDeviceUid(value: string) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function compactText(value: string | null | undefined, fallback = "-") {
  return String(value || "").trim() || fallback;
}

function prettyJson(value: unknown) {
  if (!value) {
    return "Sin respuesta remota.";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveTone(result: EqualityResponse | null) {
  if (!result) {
    return "slate" as const;
  }

  if (!result.configured) {
    return "amber" as const;
  }

  if (result.deliveryStatus) {
    return result.deliveryStatus.tone;
  }

  const code = String(result.resultCode || "").toUpperCase();

  if (code.includes("SUCCESS") || code.includes("OK") || code.includes("COMPLETED")) {
    return "emerald" as const;
  }

  if (code.includes("PENDING") || code.includes("NOT_FOUND")) {
    return "amber" as const;
  }

  if (code.includes("ERROR") || code.includes("FAIL")) {
    return "red" as const;
  }

  return "sky" as const;
}

function toneStyles(tone: DeliveryTone) {
  switch (tone) {
    case "emerald":
      return {
        badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
        panel: "border-emerald-200 bg-[linear-gradient(180deg,#f4fff7_0%,#e7f9ee_100%)] text-emerald-950",
        soft: "border-emerald-200 bg-emerald-50",
        strong: "bg-emerald-600 text-white",
        accent: "bg-emerald-500",
      };
    case "amber":
      return {
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        panel: "border-amber-200 bg-[linear-gradient(180deg,#fff9ef_0%,#fff0cf_100%)] text-amber-950",
        soft: "border-amber-200 bg-amber-50",
        strong: "bg-amber-500 text-white",
        accent: "bg-amber-500",
      };
    case "red":
      return {
        badge: "border-red-200 bg-red-50 text-red-700",
        panel: "border-red-200 bg-[linear-gradient(180deg,#fff5f5_0%,#ffe2e2_100%)] text-red-950",
        soft: "border-red-200 bg-red-50",
        strong: "bg-red-600 text-white",
        accent: "bg-red-500",
      };
    case "sky":
      return {
        badge: "border-sky-200 bg-sky-50 text-sky-700",
        panel: "border-sky-200 bg-[linear-gradient(180deg,#f4fbff_0%,#ddefff_100%)] text-sky-950",
        soft: "border-sky-200 bg-sky-50",
        strong: "bg-sky-600 text-white",
        accent: "bg-sky-500",
      };
    default:
      return {
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        panel: "border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f5f7fa_100%)] text-slate-900",
        soft: "border-slate-200 bg-slate-50",
        strong: "bg-slate-800 text-white",
        accent: "bg-slate-400",
      };
  }
}

function noticeStyles(tone: NoticeTone) {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "red":
      return "border-red-200 bg-red-50 text-red-900";
    default:
      return "border-slate-200 bg-white text-slate-700";
  }
}

function readinessCopy(result: EqualityResponse | null) {
  if (!result) {
    return {
      eyebrow: "Sin lectura activa",
      title: "Consulta un equipo para empezar",
      detail:
        "Ingresa un IMEI o deviceUid y el dashboard te dira si el equipo ya esta listo para entrega o si aun falta gestionarlo.",
    };
  }

  if (!result.configured) {
    return {
      eyebrow: "Configuracion pendiente",
      title: "Zero Touch aun no esta habilitado",
      detail:
        "Debes configurar el token del proveedor para poder consultar, inscribir o administrar equipos.",
    };
  }

  if (result.probe) {
    return {
      eyebrow: "Conectividad validada",
      title: "La integracion esta respondiendo",
      detail:
        result.resultMessage ||
        "El API de Zero Touch respondio correctamente a la prueba tecnica.",
    };
  }

  if (result.deliveryStatus?.ready) {
    return {
      eyebrow: result.deliveryStatus.label,
      title: "Si, lo puedes entregar",
      detail: result.deliveryStatus.detail,
    };
  }

  if (result.deliveryStatus) {
    return {
      eyebrow: result.deliveryStatus.label,
      title: "No lo entregues todavia",
      detail: result.deliveryStatus.detail,
    };
  }

  return {
    eyebrow: "Lectura recibida",
    title: "Revisa el estado remoto",
    detail:
      result.resultMessage ||
      "La API respondio, pero no devolvio una clasificacion de entregabilidad.",
  };
}

function SectionShell({
  children,
  eyebrow,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <section className="rounded-[30px] border border-[var(--zt-line)] bg-[var(--zt-card)] p-6 shadow-[0_18px_55px_rgba(16,33,54,0.08)]">
      <div className="inline-flex rounded-full border border-[#eadfce] bg-[#faf6ef] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--zt-muted)]">
        {eyebrow}
      </div>
      <h2 className="mt-4 text-2xl font-black tracking-tight text-[var(--zt-ink)]">
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  tone = "secondary",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone?: "danger" | "primary" | "secondary" | "success" | "warning";
}) {
  const tones = {
    danger: "bg-[#d92d20] text-white hover:bg-[#b42318]",
    primary: "bg-[var(--zt-night)] text-white hover:bg-[#1c2430]",
    secondary:
      "border border-[var(--zt-line)] bg-white text-[var(--zt-ink)] hover:bg-[#f7f2ea]",
    success: "bg-[#067647] text-white hover:bg-[#085d3a]",
    warning: "bg-[#dc6803] text-white hover:bg-[#b54708]",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-70",
        tones[tone],
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function MetricCard({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/7 px-4 py-4 backdrop-blur">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#d8dbe1]">
        {label}
      </p>
      <p className="mt-3 text-2xl font-black tracking-tight text-white">{value}</p>
      <p className="mt-2 text-sm leading-6 text-[#d8dbe1]">{detail}</p>
    </div>
  );
}

function DataPoint({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-[24px] border border-[var(--zt-line)] bg-[#fcfaf6] px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--zt-muted)]">
        {label}
      </p>
      <p className="mt-2 text-lg font-black leading-tight text-[var(--zt-ink)]">
        {value}
      </p>
      {detail && <p className="mt-2 text-sm leading-6 text-[var(--zt-muted)]">{detail}</p>}
    </div>
  );
}

function TransitionChip({ value }: { value: string }) {
  return (
    <span className="rounded-full border border-[var(--zt-line)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--zt-ink)]">
      {value}
    </span>
  );
}

export default function EqualityZeroTouchConsole({
  canAdmin,
  roleName,
}: {
  canAdmin: boolean;
  roleName: string;
}) {
  const [deviceUid, setDeviceUid] = useState("");
  const [result, setResult] = useState<EqualityResponse | null>(null);
  const [notice, setNotice] = useState<ConsoleNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<EqualityAction | null>(null);
  const consultRef = useRef<
    (options?: { deviceUid?: string; probe?: boolean; silent?: boolean }) => Promise<void>
  >(async () => {});

  const syncUrl = useCallback((nextDeviceUid: string) => {
    const params = new URLSearchParams();

    if (nextDeviceUid) {
      params.set("deviceUid", nextDeviceUid);
    }

    const nextUrl = params.toString()
      ? `/dashboard/equality?${params.toString()}`
      : "/dashboard/equality";

    window.history.replaceState(null, "", nextUrl);
  }, []);

  const consultar = useCallback(
    async (options?: { deviceUid?: string; probe?: boolean; silent?: boolean }) => {
      const probe = Boolean(options?.probe);
      const silent = Boolean(options?.silent);
      const nextDeviceUid = sanitizeDeviceUid(options?.deviceUid ?? deviceUid);

      if (!probe && !nextDeviceUid) {
        if (!silent) {
          setNotice({
            text: "Debes ingresar un deviceUid o IMEI para consultar.",
            tone: "red",
          });
        }
        return;
      }

      try {
        setLoading(true);
        if (!silent) {
          setNotice(null);
        }

        const params = new URLSearchParams();

        if (probe) {
          params.set("probe", "1");
        } else {
          params.set("deviceUid", nextDeviceUid);
        }

        const response = await fetch(`/api/equality?${params.toString()}`, {
          cache: "no-store",
        });
        const data = await response.json();

        if (!response.ok) {
          if (!silent) {
            setNotice({
              text: data.error || "No se pudo consultar Equality Zero Touch.",
              tone: "red",
            });
          }
          return;
        }

        setResult(data);

        if (!probe) {
          setDeviceUid(nextDeviceUid);
          syncUrl(nextDeviceUid);
        }

        if (!silent) {
          setNotice({
            text:
              data.deliveryStatus?.detail ||
              data.resultMessage ||
              "Consulta actualizada correctamente.",
            tone: data.deliveryStatus?.ready ? "emerald" : "slate",
          });
        }
      } catch {
        if (!silent) {
          setNotice({
            text: "No se pudo consultar Equality Zero Touch.",
            tone: "red",
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [deviceUid, syncUrl]
  );

  useEffect(() => {
    consultRef.current = consultar;
  }, [consultar]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deviceUidUrl = sanitizeDeviceUid(params.get("deviceUid") || "");

    if (deviceUidUrl) {
      setDeviceUid(deviceUidUrl);
      void consultRef.current({ deviceUid: deviceUidUrl, silent: true });
      return;
    }

    void consultRef.current({ probe: true, silent: true });
  }, []);

  useLiveRefresh(
    async () => {
      if (!result?.deviceUid || result.probe) {
        return;
      }

      await consultar({ deviceUid: result.deviceUid, silent: true });
    },
    {
      enabled: Boolean(result?.configured && result?.deviceUid && !result?.probe),
      intervalMs: 25000,
    }
  );

  const ejecutarAccion = async (action: EqualityAction) => {
    const nextDeviceUid = sanitizeDeviceUid(deviceUid || result?.deviceUid || "");

    if (!nextDeviceUid) {
      setNotice({
        text: "Debes ingresar un deviceUid antes de ejecutar acciones.",
        tone: "red",
      });
      return;
    }

    try {
      setProcessing(action);
      setNotice(null);

      const response = await fetch("/api/equality", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          deviceUid: nextDeviceUid,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setNotice({
          text: data.error || "No se pudo ejecutar la accion.",
          tone: "red",
        });
        return;
      }

      await consultar({ deviceUid: nextDeviceUid, silent: true });

      setNotice({
        text:
          data.query?.deliveryStatus?.detail ||
          data.resultMessage ||
          "Accion enviada correctamente.",
        tone:
          action === "enroll" && data.query?.deliveryStatus?.ready
            ? "emerald"
            : "slate",
      });
    } catch {
      setNotice({
        text: "No se pudo ejecutar la accion.",
        tone: "red",
      });
    } finally {
      setProcessing(null);
    }
  };

  const tone = resolveTone(result);
  const toneSet = toneStyles(tone);
  const readiness = readinessCopy(result);
  const snapshot = result?.deviceSnapshot;
  const visibleDeviceUid = compactText(result?.deviceUid || deviceUid, "Sin consulta");
  const deviceName = [snapshot?.deviceManufacturer, snapshot?.deviceMarketName || snapshot?.deviceModel]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="min-h-screen bg-[radial-gradient(circle_at_top,#fff8ea_0%,transparent_28%),linear-gradient(180deg,var(--zt-bg)_0%,#eef3f7_100%)] px-4 py-6 text-[var(--zt-ink)]"
      style={{
        ...dashboardVars,
        fontFamily: '"Trebuchet MS", "Segoe UI", sans-serif',
      }}
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="relative overflow-hidden rounded-[38px] border border-[#222a35] bg-[linear-gradient(135deg,#0f141b_0%,#17202b_58%,#222c39_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(16,33,54,0.22)] sm:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(199,154,87,0.28),transparent_22%),radial-gradient(circle_at_12%_10%,rgba(255,255,255,0.08),transparent_24%)]" />

          <div className="relative flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl">
              <div className="mb-5">
                <FinserBrand dark />
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#f1d19c]">
                  Zero Touch Dashboard
                </span>
                <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Rol: {roleName}
                </span>
              </div>

              <h1
                className="mt-5 text-4xl font-black tracking-tight sm:text-5xl"
                style={{ fontFamily: '"Arial Black", "Trebuchet MS", sans-serif' }}
              >
                Equality HBM
              </h1>

              <div className="mt-4 h-[3px] w-20 rounded-full bg-[var(--zt-gold)]" />

              <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
                {canAdmin
                  ? "Panel operativo para consultar, inscribir, bloquear, desbloquear y liberar equipos sin mezclar otros proveedores."
                  : "Panel de vendedor para consultar el equipo, inscribirlo y confirmar si ya se puede entregar al cliente."}
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Device UID: {visibleDeviceUid}
                </span>
                <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Estado: {compactText(result?.deviceState, "Sin lectura")}
                </span>
                <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Servicio: {compactText(result?.serviceDetails, "Pendiente")}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/dashboard/integraciones"
                className="rounded-2xl border border-white/12 bg-white px-5 py-3 text-sm font-semibold text-[var(--zt-ink)] transition hover:bg-[#f4ede3]"
              >
                Centro Zero Touch
              </Link>
              <Link
                href="/dashboard"
                className="rounded-2xl border border-white/12 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/16"
              >
                Volver al dashboard
              </Link>
            </div>
          </div>

          <div className="relative mt-8 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="grid gap-4 md:grid-cols-3">
              <MetricCard
                label="Decision"
                value={result?.deliveryStatus?.ready ? "Entregable" : "Pendiente"}
                detail="La lectura comercial se actualiza cada vez que consultas o ejecutas una accion."
              />
              <MetricCard
                label="HTTP remoto"
                value={String(result?.remoteStatusCode ?? "-")}
                detail="Codigo de respuesta recibido desde Equality."
              />
              <MetricCard
                label="Equipo"
                value={deviceName || "Sin identificar"}
                detail="Marca y nombre comercial reportados por Zero Touch."
              />
            </div>

            <div className={["rounded-[30px] border p-6 shadow-[0_18px_50px_rgba(16,33,54,0.12)]", toneSet.panel].join(" ")}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em]">
                    {readiness.eyebrow}
                  </p>
                  <h2 className="mt-3 text-3xl font-black tracking-tight">
                    {readiness.title}
                  </h2>
                </div>
                <span className={["mt-1 h-14 w-1.5 rounded-full shadow-sm", toneSet.accent].join(" ")} />
              </div>
              <p className="mt-4 text-sm leading-7">{readiness.detail}</p>
            </div>
          </div>
        </section>

        {notice && (
          <div className={["rounded-[26px] border px-5 py-4 text-sm font-medium shadow-sm", noticeStyles(notice.tone)].join(" ")}>
            {notice.text}
          </div>
        )}

        <SectionShell eyebrow="Control principal" title="Consulta y acciones">
          <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
            <div>
              <label className="mb-2 block text-sm font-semibold text-[var(--zt-ink)]">
                Device UID o IMEI
              </label>
              <input
                value={deviceUid}
                onChange={(event) => setDeviceUid(sanitizeDeviceUid(event.target.value))}
                placeholder="Ejemplo: 355043750428782"
                className="w-full rounded-[24px] border border-[var(--zt-line)] bg-white px-4 py-4 text-base text-[var(--zt-ink)] outline-none transition focus:border-[var(--zt-gold)] focus:ring-2 focus:ring-[#f4e3c8]"
              />
              <p className="mt-3 text-sm leading-6 text-[var(--zt-muted)]">
                Usa un solo dato de entrada. El panel consulta directo en Zero Touch y
                te devuelve el veredicto comercial del equipo.
              </p>
            </div>

            <div className="rounded-[28px] border border-[var(--zt-line)] bg-[#fcfaf6] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--zt-muted)]">
                Flujo recomendado
              </p>
              <p className="mt-3 text-lg font-black text-[var(--zt-ink)]">
                {canAdmin
                  ? "Consultar, inscribir y luego administrar el ciclo de vida."
                  : "Consultar, inscribir y validar si si se puede entregar."}
              </p>
              <p className="mt-3 text-sm leading-6 text-[var(--zt-muted)]">
                `Inscribir equipo` ya hace la alta completa del equipo. No necesitas
                botones separados para inventario o activacion.
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <ActionButton
              tone="primary"
              disabled={loading || processing !== null}
              onClick={() => void consultar({ deviceUid })}
            >
              {loading ? "Consultando..." : "Consultar equipo"}
            </ActionButton>

            <ActionButton
              tone="secondary"
              disabled={loading || processing !== null}
              onClick={() => void consultar({ probe: true })}
            >
              {loading ? "Probando..." : "Probar conectividad"}
            </ActionButton>

            <ActionButton
              tone="success"
              disabled={loading || processing !== null}
              onClick={() => void ejecutarAccion("enroll")}
            >
              {processing === "enroll" ? "Inscribiendo..." : "Inscribir equipo"}
            </ActionButton>

            {canAdmin && (
              <>
                <ActionButton
                  tone="danger"
                  disabled={loading || processing !== null}
                  onClick={() => void ejecutarAccion("lock")}
                >
                  {processing === "lock" ? "Bloqueando..." : "Bloquear"}
                </ActionButton>

                <ActionButton
                  tone="success"
                  disabled={loading || processing !== null}
                  onClick={() => void ejecutarAccion("unlock")}
                >
                  {processing === "unlock" ? "Desbloqueando..." : "Desbloquear"}
                </ActionButton>

                <ActionButton
                  tone="warning"
                  disabled={loading || processing !== null}
                  onClick={() => void ejecutarAccion("release")}
                >
                  {processing === "release" ? "Liberando..." : "Liberar"}
                </ActionButton>
              </>
            )}
          </div>

          {!canAdmin && (
            <div className="mt-5 rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900">
              Vista de {roleName}: este dashboard queda limitado a inscripcion y verificacion de entregabilidad.
            </div>
          )}
        </SectionShell>

        {result && !result.configured && (
          <div className="rounded-[28px] border border-amber-200 bg-amber-50 p-6 text-sm leading-6 text-amber-900 shadow-sm">
            Falta configurar <span className="font-semibold">EQUALITY_HBM_ACCESS_TOKEN</span> en el entorno del servidor para activar Equality Zero Touch.
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[1fr_0.95fr]">
          <SectionShell eyebrow="Decision comercial" title="Veredicto de entrega">
            {!result ? (
              <div className="rounded-[26px] border border-dashed border-[var(--zt-line)] bg-[#faf7f1] px-5 py-8 text-sm leading-6 text-[var(--zt-muted)]">
                Aun no hay una lectura del equipo. Ejecuta una consulta para ver si el dispositivo ya esta 100% entregable.
              </div>
            ) : (
              <div className="space-y-4">
                <div className={["rounded-[28px] border p-5", toneSet.panel].join(" ")}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                        Estado comercial
                      </p>
                      <h3 className="mt-2 text-3xl font-black tracking-tight">
                        {result.deliveryStatus?.ready
                          ? "Si, lo puedes entregar"
                          : result.deliveryStatus?.label || result.resultCode || "Sin resultCode"}
                      </h3>
                    </div>

                    <span className={["inline-flex rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]", toneSet.strong].join(" ")}>
                      {result.deliveryStatus?.label || "Lectura disponible"}
                    </span>
                  </div>

                  <p className="mt-4 text-sm leading-7">
                    {result.deliveryStatus?.detail ||
                      result.resultMessage ||
                      "La respuesta no incluyo un mensaje descriptivo."}
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <DataPoint
                    label="Device UID"
                    value={compactText(result.deviceUid)}
                    detail="Identificador consultado en la plataforma."
                  />
                  <DataPoint
                    label="Entregabilidad"
                    value={result.deliveryStatus?.ready ? "100% entregable" : "Aun no lista"}
                    detail="La decision de entrega usa el estado comercial derivado del API."
                  />
                  <DataPoint
                    label="Estado remoto"
                    value={compactText(result.deviceState, result.probe ? "Prueba de conectividad" : "Consulta real")}
                  />
                  <DataPoint
                    label="Servicio"
                    value={compactText(result.serviceDetails, result.canManage ? "Disponible" : "Restringida")}
                  />
                </div>
              </div>
            )}
          </SectionShell>

          <SectionShell eyebrow="Resumen tecnico" title="Lectura operativa">
            <div className="grid gap-3 md:grid-cols-2">
              <DataPoint
                label="HTTP remoto"
                value={String(result?.remoteStatusCode ?? "-")}
                detail="Codigo devuelto por Equality."
              />
              <DataPoint
                label="Ultimo check-in"
                value={formatoFecha(snapshot?.lastCheckIn || null)}
                detail="Ultimo contacto reportado por el equipo."
              />
              <DataPoint
                label="Ultimo cambio"
                value={formatoFecha(snapshot?.lastChanged || null)}
                detail="Cambio de estado mas reciente reportado."
              />
              <DataPoint
                label="Transicion activa"
                value={compactText(snapshot?.transitionState)}
                detail="Estado de transicion reportado por el hub."
              />
            </div>

            <div className="mt-4 rounded-[24px] border border-[var(--zt-line)] bg-[#fcfaf6] px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--zt-muted)]">
                Cola de transiciones
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {snapshot?.transitionQueue?.length ? (
                  snapshot.transitionQueue.map((item) => (
                    <TransitionChip key={`${visibleDeviceUid}-${item}`} value={item} />
                  ))
                ) : (
                  <span className="text-sm text-[var(--zt-muted)]">
                    No hay transiciones pendientes para este equipo.
                  </span>
                )}
              </div>
            </div>
          </SectionShell>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <SectionShell eyebrow="Perfil del equipo" title="Identidad del dispositivo">
            <div className="grid gap-3 md:grid-cols-2">
              <DataPoint
                label="Equipo"
                value={deviceName || "Sin identificar"}
                detail="Marca y referencia comercial."
              />
              <DataPoint
                label="Tenant"
                value={compactText(snapshot?.tenantName)}
                detail="Cliente o tenant asociado en Zero Touch."
              />
              <DataPoint
                label="Modelo"
                value={compactText(snapshot?.deviceModel || snapshot?.deviceMarketName)}
              />
              <DataPoint
                label="Creado"
                value={formatoFecha(snapshot?.createdTimeStamp || null)}
                detail="Momento en que Zero Touch registró el dispositivo."
              />
            </div>
          </SectionShell>

          <SectionShell eyebrow="Respuesta tecnica" title="Payload devuelto por Zero Touch">
            <div className="rounded-[26px] border border-[#1d2430] bg-[#0f141b] p-4 text-slate-100 shadow-[0_18px_45px_rgba(16,33,54,0.12)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Payload crudo
              </p>
              <pre className="mt-3 overflow-x-auto text-xs leading-6 text-slate-200">
                {prettyJson(result?.response)}
              </pre>
            </div>
          </SectionShell>
        </div>
      </div>
    </div>
  );
}
