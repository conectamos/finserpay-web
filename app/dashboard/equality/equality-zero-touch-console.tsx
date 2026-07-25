"use client";

import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  UnlockKeyhole,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  StatusPill,
} from "@/app/_components/finser-ui";
import { useLiveRefresh } from "@/lib/use-live-refresh";

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
type UiTone = "danger" | "neutral" | "positive" | "warning";

type ConsoleNotice = {
  text: string;
  tone: NoticeTone;
};

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

function statusTone(tone: DeliveryTone): UiTone {
  if (tone === "emerald") {
    return "positive";
  }

  if (tone === "amber") {
    return "warning";
  }

  if (tone === "red") {
    return "danger";
  }

  return "neutral";
}

function noticeStyles(tone: NoticeTone) {
  switch (tone) {
    case "emerald":
      return "border-[#c9df91] bg-[var(--fp-lime-soft)] text-[#4f6f0c]";
    case "amber":
      return "border-[#f0d28d] bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]";
    case "red":
      return "border-[#f3b7b2] bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]";
    default:
      return "border-[var(--fp-border)] bg-white text-[var(--fp-muted)]";
  }
}

function readinessCopy(result: EqualityResponse | null) {
  if (!result) {
    return {
      eyebrow: "Sin lectura activa",
      title: "Consulta un equipo para empezar",
      detail: "Ingresa un IMEI o Device UID para conocer su estado comercial.",
    };
  }

  if (!result.configured) {
    return {
      eyebrow: "Configuracion pendiente",
      title: "Equality no esta disponible",
      detail: "El servicio debe configurarse en el servidor antes de operar equipos.",
    };
  }

  if (result.probe) {
    return {
      eyebrow: "Servicio conectado",
      title: "La integracion esta respondiendo",
      detail:
        result.resultMessage ||
        "Equality Zero Touch respondio correctamente a la prueba.",
    };
  }

  if (result.deliveryStatus?.ready) {
    return {
      eyebrow: result.deliveryStatus.label,
      title: "Puedes entregar el equipo",
      detail: result.deliveryStatus.detail,
    };
  }

  if (result.deliveryStatus) {
    return {
      eyebrow: result.deliveryStatus.label,
      title: "No entregues el equipo todavia",
      detail: result.deliveryStatus.detail,
    };
  }

  return {
    eyebrow: "Lectura recibida",
    title: "Revisa el estado remoto",
    detail:
      result.resultMessage ||
      "Equality respondio, pero no devolvio una clasificacion de entrega.",
  };
}

function serviceCopy(result: EqualityResponse | null): {
  detail: string;
  label: string;
  tone: UiTone;
} {
  if (!result) {
    return {
      detail: "Prueba la conexion o consulta un equipo para validar el servicio.",
      label: "Servicio sin verificar",
      tone: "neutral",
    };
  }

  if (!result.configured) {
    return {
      detail: "La integracion debe configurarse en el servidor.",
      label: "Configuracion pendiente",
      tone: "warning",
    };
  }

  return {
    detail: "Equality Zero Touch esta disponible para operar equipos.",
    label: "Servicio conectado",
    tone: "positive",
  };
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
            text: "Debes ingresar un Device UID o IMEI para consultar.",
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
        text: "Debes ingresar un Device UID antes de ejecutar acciones.",
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

  const readiness = readinessCopy(result);
  const service = serviceCopy(result);
  const snapshot = result?.deviceSnapshot;
  const visibleDeviceUid = compactText(result?.deviceUid || deviceUid, "Sin consulta");
  const deviceName = [
    snapshot?.deviceManufacturer,
    snapshot?.deviceMarketName || snapshot?.deviceModel,
  ]
    .filter(Boolean)
    .join(" ");
  const busy = loading || processing !== null;

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        eyebrow="Control de equipos"
        title="Equality Zero Touch"
        description="Consulta un equipo y administra su estado remoto desde una sola vista."
        actions={
          <Link
            href="/dashboard/integraciones"
            className="fp-ui-button is-secondary"
          >
            <ArrowLeft aria-hidden="true" size={17} />
            Integraciones
          </Link>
        }
      />

      <Card className="mt-5 flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={[
              "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
              service.tone === "positive"
                ? "bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]"
                : service.tone === "warning"
                  ? "bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]"
                  : "bg-[#eef1f4] text-[var(--fp-muted)]",
            ].join(" ")}
          >
            {loading && !result ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={19} />
            ) : service.tone === "positive" ? (
              <CircleCheck aria-hidden="true" size={19} />
            ) : service.tone === "warning" ? (
              <CircleAlert aria-hidden="true" size={19} />
            ) : (
              <Activity aria-hidden="true" size={19} />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-extrabold text-[var(--fp-graphite)]">
                {service.label}
              </h2>
              <StatusPill tone={service.tone}>
                {result?.remoteStatusCode ? `HTTP ${result.remoteStatusCode}` : "Equality"}
              </StatusPill>
            </div>
            <p className="mt-1 text-sm text-[var(--fp-muted)]">{service.detail}</p>
          </div>
        </div>

        <Button
          variant="secondary"
          className="h-11 shrink-0"
          disabled={busy}
          onClick={() => void consultar({ probe: true })}
        >
          {loading ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
          ) : (
            <RefreshCw aria-hidden="true" size={17} />
          )}
          Probar conexion
        </Button>
      </Card>

      {notice && (
        <div
          className={[
            "mt-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm font-semibold",
            noticeStyles(notice.tone),
          ].join(" ")}
          role="status"
          aria-live="polite"
        >
          {notice.tone === "red" || notice.tone === "amber" ? (
            <CircleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
          ) : (
            <CircleCheck aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      <Card className="mt-5 overflow-hidden">
        <section className="border-b border-[var(--fp-border)] p-5 sm:p-6">
          <div>
            <p className="fp-ui-eyebrow">Consulta principal</p>
            <h2 className="mt-1 text-xl font-extrabold text-[var(--fp-graphite)]">
              Buscar equipo
            </h2>
            <p className="mt-1 text-sm text-[var(--fp-muted)]">
              Ingresa el IMEI o Device UID exacto del dispositivo.
            </p>
          </div>

          <form
            className="mt-5 flex flex-col gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void consultar({ deviceUid });
            }}
          >
            <label className="sr-only" htmlFor="equality-device-uid">
              IMEI o Device UID
            </label>
            <div className="relative min-w-0 flex-1">
              <Smartphone
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--fp-muted)]"
                size={19}
              />
              <Input
                id="equality-device-uid"
                value={deviceUid}
                onChange={(event) =>
                  setDeviceUid(sanitizeDeviceUid(event.target.value))
                }
                placeholder="IMEI o Device UID"
                autoComplete="off"
                className="h-12 !pl-11"
              />
            </div>
            <Button
              type="submit"
              className="h-12 min-w-[136px]"
              disabled={busy}
            >
              {loading ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : (
                <Search aria-hidden="true" size={18} />
              )}
              {loading ? "Consultando" : "Consultar"}
            </Button>
          </form>
        </section>

        {result && !result.probe ? (
          <div
            className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(290px,0.8fr)]"
            aria-live="polite"
          >
            <section className="p-5 sm:p-6 lg:p-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-4">
                  <span
                    className={[
                      "grid h-12 w-12 shrink-0 place-items-center rounded-lg",
                      statusTone(resolveTone(result)) === "positive"
                        ? "bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]"
                        : statusTone(resolveTone(result)) === "warning"
                          ? "bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]"
                          : statusTone(resolveTone(result)) === "danger"
                            ? "bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]"
                            : "bg-[#eef1f4] text-[var(--fp-muted)]",
                    ].join(" ")}
                  >
                    {result.deliveryStatus?.ready ? (
                      <ShieldCheck aria-hidden="true" size={24} />
                    ) : (
                      <CircleAlert aria-hidden="true" size={24} />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="fp-ui-eyebrow">Resultado de entrega</p>
                    <h2 className="mt-1 text-2xl font-black leading-tight text-[var(--fp-graphite)] sm:text-3xl">
                      {readiness.title}
                    </h2>
                  </div>
                </div>
                <StatusPill
                  tone={statusTone(resolveTone(result))}
                  className="shrink-0 self-start"
                >
                  {readiness.eyebrow}
                </StatusPill>
              </div>

              <p className="mt-5 max-w-2xl text-sm leading-6 text-[var(--fp-muted)] sm:text-base">
                {readiness.detail}
              </p>
            </section>

            <aside className="border-t border-[var(--fp-border)] bg-[#fafbfa] p-5 sm:p-6 lg:border-l lg:border-t-0">
              <p className="text-xs font-extrabold uppercase text-[var(--fp-muted)]">
                Equipo consultado
              </p>
              <h3 className="mt-2 break-words text-lg font-black text-[var(--fp-graphite)]">
                {deviceName || "Equipo sin identificar"}
              </h3>

              <dl className="mt-5 divide-y divide-[var(--fp-border)] text-sm">
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-3 first:pt-0">
                  <dt className="text-[var(--fp-muted)]">Identificador</dt>
                  <dd className="break-all text-right font-bold text-[var(--fp-graphite)]">
                    {visibleDeviceUid}
                  </dd>
                </div>
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-3">
                  <dt className="text-[var(--fp-muted)]">Estado remoto</dt>
                  <dd className="break-words text-right font-bold text-[var(--fp-graphite)]">
                    {compactText(result.deviceState, "Sin estado")}
                  </dd>
                </div>
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-3">
                  <dt className="text-[var(--fp-muted)]">Servicio</dt>
                  <dd className="break-words text-right font-bold text-[var(--fp-graphite)]">
                    {compactText(
                      result.serviceDetails || snapshot?.serviceDetails,
                      "Sin informacion"
                    )}
                  </dd>
                </div>
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-3 last:pb-0">
                  <dt className="text-[var(--fp-muted)]">Ultimo contacto</dt>
                  <dd className="text-right font-bold text-[var(--fp-graphite)]">
                    {formatoFecha(snapshot?.lastCheckIn || null)}
                  </dd>
                </div>
              </dl>
            </aside>
          </div>
        ) : (
          <div className="p-5 sm:p-6">
            <EmptyState
              className="min-h-[190px] border-0 shadow-none"
              title="Consulta un equipo para ver su estado"
              description="Aqui aparecera el veredicto de entrega y la informacion esencial del dispositivo."
            />
          </div>
        )}

        <section className="border-t border-[var(--fp-border)] bg-[#fafbfa] p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="font-extrabold text-[var(--fp-graphite)]">
                Acciones del equipo
              </h2>
              <p className="mt-1 text-sm text-[var(--fp-muted)]">
                Las acciones se ejecutan sobre el identificador ingresado.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="h-11"
                disabled={busy}
                onClick={() => void ejecutarAccion("enroll")}
              >
                {processing === "enroll" ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="animate-spin"
                    size={17}
                  />
                ) : (
                  <PackageCheck aria-hidden="true" size={17} />
                )}
                {processing === "enroll" ? "Inscribiendo" : "Inscribir"}
              </Button>

              {canAdmin && (
                <>
                  <span
                    className="mx-1 hidden h-8 w-px self-center bg-[var(--fp-border)] sm:block"
                    aria-hidden="true"
                  />
                  <Button
                    variant="danger"
                    className="h-11"
                    disabled={busy}
                    onClick={() => void ejecutarAccion("lock")}
                  >
                    {processing === "lock" ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin"
                        size={17}
                      />
                    ) : (
                      <LockKeyhole aria-hidden="true" size={17} />
                    )}
                    {processing === "lock" ? "Bloqueando" : "Bloquear"}
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-11"
                    disabled={busy}
                    onClick={() => void ejecutarAccion("unlock")}
                  >
                    {processing === "unlock" ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin"
                        size={17}
                      />
                    ) : (
                      <UnlockKeyhole aria-hidden="true" size={17} />
                    )}
                    {processing === "unlock" ? "Desbloqueando" : "Desbloquear"}
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-11"
                    disabled={busy}
                    onClick={() => void ejecutarAccion("release")}
                  >
                    {processing === "release" ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin"
                        size={17}
                      />
                    ) : (
                      <ShieldCheck aria-hidden="true" size={17} />
                    )}
                    {processing === "release" ? "Liberando" : "Liberar"}
                  </Button>
                </>
              )}
            </div>
          </div>

          {!canAdmin && (
            <p className="mt-4 border-t border-[var(--fp-border)] pt-4 text-sm text-[var(--fp-muted)]">
              Perfil {roleName}: puedes consultar e inscribir equipos. Las acciones
              administrativas estan restringidas.
            </p>
          )}
        </section>
      </Card>

      {result && !result.probe && (
        <Card className="mt-4 overflow-hidden">
          <details className="group">
            <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 marker:hidden sm:px-6">
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#eef1f4] text-[var(--fp-muted)]">
                  <Server aria-hidden="true" size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block font-extrabold text-[var(--fp-graphite)]">
                    Detalle tecnico
                  </span>
                  <span className="block text-sm text-[var(--fp-muted)]">
                    Diagnostico y respuesta remota
                  </span>
                </span>
              </span>
              <ChevronDown
                aria-hidden="true"
                className="shrink-0 text-[var(--fp-muted)] transition group-open:rotate-180"
                size={20}
              />
            </summary>

            <div className="border-t border-[var(--fp-border)] p-5 sm:p-6">
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    HTTP remoto
                  </dt>
                  <dd className="mt-1 font-bold text-[var(--fp-graphite)]">
                    {String(result.remoteStatusCode ?? "-")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Codigo
                  </dt>
                  <dd className="mt-1 break-words font-bold text-[var(--fp-graphite)]">
                    {compactText(result.resultCode)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Tenant
                  </dt>
                  <dd className="mt-1 break-words font-bold text-[var(--fp-graphite)]">
                    {compactText(snapshot?.tenantName)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Modelo
                  </dt>
                  <dd className="mt-1 break-words font-bold text-[var(--fp-graphite)]">
                    {compactText(
                      snapshot?.deviceModel || snapshot?.deviceMarketName
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Creado
                  </dt>
                  <dd className="mt-1 text-sm font-bold text-[var(--fp-graphite)]">
                    {formatoFecha(snapshot?.createdTimeStamp || null)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Ultimo cambio
                  </dt>
                  <dd className="mt-1 text-sm font-bold text-[var(--fp-graphite)]">
                    {formatoFecha(snapshot?.lastChanged || null)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Transicion
                  </dt>
                  <dd className="mt-1 break-words font-bold text-[var(--fp-graphite)]">
                    {compactText(snapshot?.transitionState)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                    Permisos
                  </dt>
                  <dd className="mt-1 font-bold text-[var(--fp-graphite)]">
                    {result.canManage ? "Administracion" : "Solo consulta"}
                  </dd>
                </div>
              </dl>

              <div className="mt-6 border-t border-[var(--fp-border)] pt-5">
                <p className="text-xs font-bold uppercase text-[var(--fp-muted)]">
                  Cola de transiciones
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {snapshot?.transitionQueue?.length ? (
                    snapshot.transitionQueue.map((item) => (
                      <StatusPill key={`${visibleDeviceUid}-${item}`}>
                        {item}
                      </StatusPill>
                    ))
                  ) : (
                    <span className="text-sm text-[var(--fp-muted)]">
                      Sin transiciones pendientes.
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-6 overflow-hidden rounded-lg border border-[#2b333d] bg-[#11161c]">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-xs font-bold uppercase text-slate-400">
                  <Server aria-hidden="true" size={15} />
                  Respuesta remota
                </div>
                <pre className="max-h-72 overflow-auto p-4 text-xs leading-6 text-slate-200">
                  {prettyJson(result.response)}
                </pre>
              </div>
            </div>
          </details>
        </Card>
      )}
    </main>
  );
}
