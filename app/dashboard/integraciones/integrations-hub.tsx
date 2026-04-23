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
  session: ApiResult<SessionUser>;
  source: string;
};

type Tone = "amber" | "emerald" | "red" | "slate" | "sky";

type StatusMeta = {
  detail: string;
  label: string;
  metric: string;
  tone: Tone;
};

type EndpointCardData = {
  detail: string;
  label: string;
  latency: string;
  metric: string;
  route: string;
  title: string;
  tone: Tone;
};

function formatoHora(valor?: string | null) {
  if (!valor) {
    return "Sin actualizar";
  }

  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(valor));
}

function formatoLatencia(valor: number) {
  if (!valor) {
    return "-";
  }

  return `${valor} ms`;
}

function toneClasses(tone: Tone) {
  switch (tone) {
    case "emerald":
      return {
        badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
        glow: "bg-emerald-500",
        soft: "border-emerald-200 bg-emerald-50",
      };
    case "amber":
      return {
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        glow: "bg-amber-500",
        soft: "border-amber-200 bg-amber-50",
      };
    case "red":
      return {
        badge: "border-red-200 bg-red-50 text-red-700",
        glow: "bg-red-500",
        soft: "border-red-200 bg-red-50",
      };
    case "sky":
      return {
        badge: "border-sky-200 bg-sky-50 text-sky-700",
        glow: "bg-sky-500",
        soft: "border-sky-200 bg-sky-50",
      };
    default:
      return {
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        glow: "bg-slate-400",
        soft: "border-slate-200 bg-slate-50",
      };
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
        data: null,
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
        error instanceof Error ? error.message : "No se pudo consultar el API",
    };
  }
}

function idleStatus(detail: string, metric = "Esperando"): StatusMeta {
  return {
    label: "Pendiente",
    tone: "slate",
    detail,
    metric,
  };
}

function resolveSessionStatus(result?: ApiResult<SessionUser> | null): StatusMeta {
  if (!result) {
    return idleStatus("Validando la sesion activa del usuario.");
  }

  if (result.ok && result.data) {
    return {
      label: "Activa",
      tone: "emerald",
      detail: `${result.data.nombre} opera como ${result.data.rolNombre}.`,
      metric: result.data.sedeNombre,
    };
  }

  if (result.status === 401) {
    return {
      label: "Expirada",
      tone: "red",
      detail: "La sesion ya no es valida para consultar Zero Touch.",
      metric: "401",
    };
  }

  return {
    label: "Error",
    tone: "red",
    detail: result?.error || "No fue posible leer la sesion actual.",
    metric: result?.status ? String(result.status) : "Sin red",
  };
}

function resolveEqualityStatus(
  result?: ApiResult<EqualitySummary> | null
): StatusMeta {
  if (!result) {
    return idleStatus("Ejecutando una verificacion segura de Equality Zero Touch.");
  }

  if (result.ok && result.data) {
    if (!result.data.configured) {
      return {
        label: "Sin token",
        tone: "amber",
        detail:
          "Configura EQUALITY_HBM_ACCESS_TOKEN para habilitar consultas y acciones remotas.",
        metric: "Config",
      };
    }

    const resultCode = String(result.data.resultCode || "").toUpperCase();

    if (resultCode.includes("PENDING")) {
      return {
        label: "Pendiente",
        tone: "amber",
        detail:
          result.data.resultMessage ||
          "Zero Touch aun no termina su configuracion.",
        metric: result.data.remoteStatusCode
          ? String(result.data.remoteStatusCode)
          : "Pendiente",
      };
    }

    return {
      label: "Conectada",
      tone: "emerald",
      detail:
        result.data.resultMessage ||
        "Equality Zero Touch respondio correctamente a la prueba de integracion.",
      metric: result.data.canManage ? "Gestion on" : "Solo lectura",
    };
  }

  if (result.status === 401) {
    return {
      label: "Sin acceso",
      tone: "red",
      detail: "Equality Zero Touch requiere sesion activa en el sistema.",
      metric: "401",
    };
  }

  return {
    label: "Error",
    tone: "red",
    detail: result.error || "No fue posible consultar Equality Zero Touch.",
    metric: result.status ? String(result.status) : "Sin red",
  };
}

function MetricTile({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/6 px-4 py-4 backdrop-blur">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
        {label}
      </p>
      <p className="mt-3 text-2xl font-black tracking-tight text-white">
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-300">{detail}</p>
    </div>
  );
}

function EndpointCard({
  detail,
  label,
  latency,
  metric,
  route,
  title,
  tone,
}: EndpointCardData) {
  const styles = toneClasses(tone);

  return (
    <article className="relative overflow-hidden rounded-[28px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-[0_16px_45px_rgba(15,23,42,0.07)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(199,154,87,0.10),transparent_30%)]" />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              {route}
            </p>
            <h3 className="mt-3 text-xl font-black tracking-tight text-slate-950">
              {title}
            </h3>
          </div>

          <span className={["mt-1 h-11 w-1.5 rounded-full", styles.glow].join(" ")} />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <span
            className={[
              "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
              styles.badge,
            ].join(" ")}
          >
            {label}
          </span>

          <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
            {latency}
          </span>
        </div>

        <p className="mt-4 text-sm leading-6 text-slate-600">{detail}</p>

        <div className={["mt-5 rounded-2xl border px-4 py-4", styles.soft].join(" ")}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Resumen rapido
          </p>
          <p className="mt-2 text-lg font-black tracking-tight text-slate-950">
            {metric}
          </p>
        </div>
      </div>
    </article>
  );
}

function SummaryShell({
  children,
  eyebrow,
  title,
}: {
  children: React.ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <section className="rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
      <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
        {eyebrow}
      </div>
      <h2 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
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

          const [session, equality] = await Promise.all([
            fetchJson<SessionUser>("/api/session"),
            fetchJson<EqualitySummary>("/api/equality?probe=1"),
          ]);

          startTransition(() => {
            setSnapshot({
              session,
              equality,
              loadedAt: new Date().toISOString(),
              source,
            });
          });
        } catch (error) {
          setMessage(
            error instanceof Error
              ? error.message
              : "No se pudo actualizar el centro de integraciones"
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

  useLiveRefresh(
    async () => {
      await loadSnapshot("live");
    },
    {
      enabled: true,
      intervalMs: 20000,
      runOnMount: true,
    }
  );

  const sessionStatus = resolveSessionStatus(snapshot?.session);
  const equalityStatus = resolveEqualityStatus(snapshot?.equality);

  const localEndpointCards: EndpointCardData[] = [
    {
      title: "Sesion local",
      route: "GET /api/session",
      latency: formatoLatencia(snapshot?.session.latencyMs || 0),
      ...sessionStatus,
    },
  ];

  const externalEndpointCards: EndpointCardData[] = [
    {
      title: "Equality Zero Touch",
      route: "GET /api/equality",
      latency: formatoLatencia(snapshot?.equality.latencyMs || 0),
      ...equalityStatus,
    },
  ];

  const endpointCards = [...localEndpointCards, ...externalEndpointCards];
  const localOnlineCount = localEndpointCards.filter(
    (card) => card.tone === "emerald" || card.tone === "sky"
  ).length;
  const externalOnlineCount = externalEndpointCards.filter(
    (card) => card.tone === "emerald" || card.tone === "sky"
  ).length;
  const alertCount = endpointCards.filter(
    (card) => card.tone === "amber" || card.tone === "red"
  ).length;

  const equalityData = snapshot?.equality.data;
  const hasBusyState = loading || isPending;
  const canAdmin = String(initialSession.rolNombre || "").toUpperCase() === "ADMIN";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#f2f5f9_100%)] px-4 py-8 text-slate-950">
      <div className="mx-auto max-w-7xl">
        <section className="relative overflow-hidden rounded-[36px] border border-[#2a2d33] bg-[linear-gradient(135deg,#0d0f13_0%,#171a21_55%,#202631_100%)] px-6 py-8 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] sm:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(199,154,87,0.28),transparent_24%),radial-gradient(circle_at_12%_0%,rgba(255,255,255,0.07),transparent_24%)]" />

          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/12 bg-white/6 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-[#f1d19c]">
                Centro Zero Touch
              </div>

              <h1 className="mt-5 text-4xl font-black tracking-tight sm:text-5xl">
                Zero Touch en vivo
              </h1>

              <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
                El hub ya no mezcla otros proveedores. Aqui solo se valida la
                sesion local y el estado operativo de Equality Zero Touch.
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Usuario: {initialSession.nombre}
                </span>
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Rol: {initialSession.rolNombre}
                </span>
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Cobertura: {initialSession.sedeNombre}
                </span>
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Fuente: {snapshot?.source === "live" ? "Auto refresh" : "Manual"}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void loadSnapshot("manual")}
                disabled={hasBusyState}
                className="rounded-2xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/16 disabled:opacity-70"
              >
                {hasBusyState ? "Actualizando..." : "Refrescar estado"}
              </button>

              <Link
                href="/dashboard"
                className="rounded-2xl border border-white/15 bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-100"
              >
                Volver al dashboard
              </Link>
            </div>
          </div>

          <div className="relative mt-8 grid gap-4 md:grid-cols-4">
            <MetricTile
              label="Acceso local"
              value={`${localOnlineCount}/${localEndpointCards.length}`}
              detail="Valida la sesion del usuario que opera el portal."
            />
            <MetricTile
              label="Zero Touch"
              value={`${externalOnlineCount}/${externalEndpointCards.length}`}
              detail="Chequeo actual de la integracion remota."
            />
            <MetricTile
              label="Alertas"
              value={`${alertCount}`}
              detail={`Sobre ${endpointCards.length} chequeos ejecutados.`}
            />
            <MetricTile
              label="Ultima lectura"
              value={formatoHora(snapshot?.loadedAt || null)}
              detail="Se refresca cada 20 segundos y al volver a enfocar la ventana."
            />
          </div>
        </section>

        {message && (
          <div className="mt-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 shadow-sm">
            {message}
          </div>
        )}

        <DeviceOperationsConsole canAdmin={canAdmin} />

        <section className="mt-8 grid gap-8">
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                  Acceso local
                </div>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                  Sesion y autenticacion
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  El proyecto mantiene una sola verificacion interna para confirmar
                  que el usuario autenticado puede operar Zero Touch.
                </p>
              </div>

              <div className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                {localOnlineCount}/{localEndpointCards.length} activa
              </div>
            </div>

            <div className="grid gap-5 xl:grid-cols-1">
              {localEndpointCards.map((card) => (
                <EndpointCard key={card.route} {...card} />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                  Integracion externa
                </div>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                  Equality Zero Touch
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  La consola remota del proyecto ya opera solo con Zero Touch.
                </p>
              </div>

              <div className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                {externalOnlineCount}/{externalEndpointCards.length} activa
              </div>
            </div>

            <div className="grid gap-5 xl:grid-cols-1">
              {externalEndpointCards.map((card) => (
                <EndpointCard key={card.route} {...card} />
              ))}
            </div>
          </div>
        </section>

        <section className="mt-8 grid gap-8 xl:grid-cols-2">
          <SummaryShell eyebrow="Portal local" title="Contexto de acceso">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-[#e6dece] bg-white/90 px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Nombre
                </p>
                <p className="mt-2 text-2xl font-black text-slate-950">
                  {initialSession.nombre}
                </p>
              </div>

              <div className="rounded-2xl border border-[#e6dece] bg-white/90 px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Rol
                </p>
                <p className="mt-2 text-2xl font-black text-slate-950">
                  {initialSession.rolNombre}
                </p>
              </div>

              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                  Usuario
                </p>
                <p className="mt-2 text-2xl font-black text-emerald-700">
                  {initialSession.usuario}
                </p>
              </div>

              <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                  Cobertura
                </p>
                <p className="mt-2 text-2xl font-black text-sky-700">
                  {initialSession.sedeNombre}
                </p>
              </div>
            </div>

            <div className="mt-5">
              <Link
                href="/dashboard"
                className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Volver al panel principal
              </Link>
            </div>
          </SummaryShell>

          <SummaryShell eyebrow="Integracion externa" title="Estado Zero Touch">
            <div className="rounded-2xl border border-[#e6dece] bg-white/90 px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Estado
              </p>
              <p className="mt-2 text-3xl font-black text-slate-950">
                {equalityStatus.label}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {equalityStatus.detail}
              </p>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Token
                </p>
                <p className="mt-2 text-lg font-black text-slate-950">
                  {equalityData?.configured ? "Configurado" : "Pendiente"}
                </p>
              </div>

              <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Variante
                </p>
                <p className="mt-2 text-lg font-black text-slate-950">A</p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Probe actual
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {equalityData?.deviceUid
                    ? `La verificacion se ejecuto sobre ${equalityData.deviceUid}.`
                    : "Aun no hay una prueba activa de Equality."}
                </p>
              </div>

              <Link
                href="/dashboard/equality"
                className="inline-flex rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Abrir consola Equality
              </Link>
            </div>
          </SummaryShell>
        </section>

        <section className="mt-8 rounded-[32px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                Accesos rapidos
              </div>
              <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
                Rutas disponibles
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                Las pantallas visibles quedaron limitadas a fabrica de creditos,
                dashboard y Zero Touch.
              </p>
            </div>

            <div className="rounded-full border border-[#e7dccb] bg-[#faf7f1] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
              Ultima lectura: {formatoHora(snapshot?.loadedAt || null)}
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Link
              href="/dashboard/creditos"
              className="rounded-[24px] border border-[#e6dece] bg-white px-5 py-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Operacion comercial
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-slate-950">
                Fabrica de creditos
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Genera creditos, inscribe equipos y valida entregabilidad.
              </p>
            </Link>

            <Link
              href="/dashboard"
              className="rounded-[24px] border border-[#e6dece] bg-white px-5 py-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Control central
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-slate-950">
                Dashboard
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Vuelve a la vista principal del portal.
              </p>
            </Link>

            <Link
              href="/dashboard/equality"
              className="rounded-[24px] border border-[#e6dece] bg-white px-5 py-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                API externa
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-slate-950">
                Equality Zero Touch
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Consulta, inscribe y opera el ciclo de vida del equipo.
              </p>
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
