"use client";

import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
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
  Input,
  PageHeader,
  StatusPill,
} from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import styles from "./equality-zero-touch-console.module.css";

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
  | "release"
  | "unlock";

const actionCopy = {
  enroll: { label: "Inscribir equipo", description: "Se inscribirá el equipo y se activará su servicio de financiación." },
  unlock: { label: "Desbloquear equipo", description: "Se enviará la orden de desbloqueo al equipo." },
  lock: { label: "Bloquear equipo", description: "Se restringirá el uso del equipo. Verifica que corresponda aplicar este bloqueo." },
  release: { label: "Liberar equipo", description: "Se finalizará el servicio de financiación del equipo. Esta acción es distinta de un desbloqueo." },
};

type DeliveryTone = "amber" | "emerald" | "red" | "sky" | "slate";
type NoticeTone = "amber" | "emerald" | "red" | "slate";
type UiTone = "danger" | "neutral" | "positive" | "warning";

type ConsoleNotice = {
  text: string;
  tone: NoticeTone;
  source?: "query";
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
      eyebrow: "Configuración pendiente",
      title: "Equality no está disponible",
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
      title: "No entregues el equipo todavía",
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
      label: "Sin verificar",
      tone: "neutral",
    };
  }

  if (!result.configured) {
    return {
      detail: "La integracion debe configurarse en el servidor.",
      label: "Configuración pendiente",
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
  const [confirmation, setConfirmation] = useState<{ action: EqualityAction; deviceUid: string } | null>(null);
  const [connectionResult, setConnectionResult] = useState<EqualityResponse | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const queryInFlight = useRef(false);
  const actionInFlight = useRef(false);
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

      if (queryInFlight.current) return;

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
        queryInFlight.current = true;
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
          setConnectionError(true);
          setNotice({ text: data.error || "No se pudo consultar Equality Zero Touch.", tone: "red", source: "query" });
          return;
        }

        setConnectionError(false);
        setConnectionResult(data);
        if (!probe) setResult(data);

        if (!probe && !silent) {
          setDeviceUid(nextDeviceUid);
          syncUrl(nextDeviceUid);
        }

        setNotice((previous) => !silent || previous?.source === "query" ? null : previous);
      } catch {
        setConnectionError(true);
        setNotice({ text: "No se pudo consultar Equality Zero Touch. Intenta de nuevo.", tone: "red", source: "query" });
      } finally {
        queryInFlight.current = false;
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
      if (!result?.deviceUid || result.probe || actionInFlight.current) {
        return;
      }

      await consultar({ deviceUid: result.deviceUid, silent: true });
    },
    {
      enabled: Boolean(result?.configured && result?.deviceUid && !result?.probe && !confirmation && !processing && sanitizeDeviceUid(deviceUid) === result.deviceUid),
      intervalMs: 25000,
    }
  );

  const ejecutarAccion = async (action: EqualityAction, confirmedDeviceUid: string) => {
    const nextDeviceUid = sanitizeDeviceUid(confirmedDeviceUid);

    if (actionInFlight.current || queryInFlight.current) return;
    if (!result?.configured || connectionError || !result.canManage || !canAdmin || nextDeviceUid !== result.deviceUid || nextDeviceUid !== sanitizeDeviceUid(deviceUid)) return;

    if (!nextDeviceUid) {
      setNotice({
        text: "Debes ingresar un Device UID antes de ejecutar acciones.",
        tone: "red",
      });
      return;
    }

    try {
      actionInFlight.current = true;
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

      if (!response.ok || data.ok === false) {
        setConfirmation(null);
        setNotice({
          text: data.error || data.resultMessage || "No se pudo ejecutar la acción.",
          tone: "red",
        });
        return;
      }

      await consultar({ deviceUid: nextDeviceUid, silent: true });
      setConfirmation(null);

      setNotice({
        text:
          data.query?.deliveryStatus?.detail ||
          data.resultMessage ||
          "Orden enviada. El estado se actualizará al recibir la confirmación del equipo.",
        tone:
          action === "enroll" && data.query?.deliveryStatus?.ready
            ? "emerald"
            : "slate",
      });
    } catch {
      setConfirmation(null);
      setNotice({
        text: "No se pudo ejecutar la accion.",
        tone: "red",
      });
    } finally {
      actionInFlight.current = false;
      setProcessing(null);
    }
  };

  const readiness = readinessCopy(result);
  const service = connectionError
    ? { label: "Conexión sin confirmar", tone: "warning" as UiTone }
    : serviceCopy(connectionResult);
  const snapshot = result?.deviceSnapshot;
  const visibleDeviceUid = compactText(result?.deviceUid, "Sin consulta");
  const deviceName = [snapshot?.deviceManufacturer, snapshot?.deviceMarketName || snapshot?.deviceModel]
    .filter(Boolean).join(" ");
  const busy = loading || processing !== null;
  const matchesQuery = Boolean(result?.deviceUid && result.deviceUid === sanitizeDeviceUid(deviceUid));
  const canOperate = Boolean(matchesQuery && result?.configured && connectionResult?.configured && !connectionError && result?.canManage && canAdmin);
  const actionHint = !result ? "Consulta un equipo para habilitar sus acciones."
    : !matchesQuery ? "Consulta el nuevo identificador antes de operar."
    : connectionError ? "Verifica la conexión antes de operar."
    : !result.configured || !connectionResult?.configured ? "Configura la integración para operar."
    : !result.canManage || !canAdmin ? `Perfil ${roleName}: sin permisos para administrar este equipo.`
    : "Las órdenes se aplican al equipo consultado.";
  const requestAction = (action: EqualityAction) => {
    if (!canOperate || busy || queryInFlight.current || actionInFlight.current) return;
    setConfirmation({ action, deviceUid: result!.deviceUid });
  };
  const diagnostics = result ? [
    ["HTTP remoto", String(result.remoteStatusCode ?? "—")],
    ["Código", compactText(result.resultCode)],
    ["Tenant", compactText(snapshot?.tenantName)],
    ["Modelo", compactText(snapshot?.deviceModel || snapshot?.deviceMarketName)],
    ["Creado", formatoFecha(snapshot?.createdTimeStamp || null)],
    ["Último cambio", formatoFecha(snapshot?.lastChanged || null)],
    ["Transición", compactText(snapshot?.transitionState)],
    ["Permisos", result.canManage ? "Administración" : "Solo consulta"],
  ] : [];

  return (
    <main className={styles.page}>
      <PageHeader eyebrow="CONTROL DE EQUIPOS" title="Equality Zero Touch"
        description="Consulta y gestión remota de equipos."
        actions={<Link href="/dashboard/integraciones" className="fp-ui-button is-secondary"><ArrowLeft size={17} aria-hidden="true" />Integraciones</Link>}
      />

      <div className={styles.connectionBar}>
        <div className={styles.connectionStatus} role="status" aria-live="polite">
          <Activity size={17} aria-hidden="true" />
          <span>Estado del servicio</span>
          <StatusPill tone={service.tone}>{loading && !connectionResult ? "Verificando…" : service.label}</StatusPill>
        </div>
        <Button variant="ghost" onClick={() => void consultar({ probe: true })} disabled={busy || Boolean(confirmation)}>
          <RefreshCw size={16} aria-hidden="true" className={loading ? styles.spin : undefined} />Probar conexión
        </Button>
      </div>

      <Card className={styles.searchCard}>
        <div className={styles.searchIntro}>
          <span className={styles.searchIcon}><Smartphone size={26} aria-hidden="true" /></span>
          <div><h2>Buscar equipo</h2><p>Ingresa el identificador exacto del dispositivo.</p></div>
        </div>
        <form className={styles.searchForm} onSubmit={(event) => { event.preventDefault(); if (!confirmation && !actionInFlight.current) void consultar({ deviceUid }); }}>
          <label htmlFor="equality-device-uid">IMEI o Device UID</label>
          <div className={styles.searchControls}>
            <Input id="equality-device-uid" value={deviceUid} autoComplete="off" spellCheck={false}
              placeholder="Escribe el IMEI o Device UID"
              onChange={(event) => setDeviceUid(sanitizeDeviceUid(event.target.value))}
              disabled={busy || Boolean(confirmation)}
            />
            <Button type="submit" disabled={busy || Boolean(confirmation)}>
              {loading ? <LoaderCircle className={styles.spin} size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
              {loading ? "Consultando…" : "Consultar"}
            </Button>
          </div>
        </form>
      </Card>

      {notice && <div className={`${styles.notice} ${noticeStyles(notice.tone)}`} role={notice.tone === "red" ? "alert" : "status"}>
        {notice.tone === "red" || notice.tone === "amber" ? <CircleAlert size={18} aria-hidden="true" /> : <CircleCheck size={18} aria-hidden="true" />}
        <span>{notice.text}</span>
      </div>}

      <div className={styles.workspace}>
        <Card className={styles.deviceCard}>
          <div className={styles.sectionHeader}><h2>Estado del equipo</h2>
            {result && <span className={styles.readingLabel}>{connectionError ? "Última lectura recibida" : loading ? "Actualizando…" : "Actualización automática"}</span>}
          </div>
          {result ? <div aria-live="polite">
            <div className={styles.deviceIdentity}>
              <span className={styles.deviceIcon}><Smartphone size={32} aria-hidden="true" /></span>
              <div><span className={styles.fieldLabel}>Equipo consultado</span><h3>{deviceName || "Equipo sin identificar"}</h3><p>IMEI / Device UID <strong>{visibleDeviceUid}</strong></p></div>
            </div>
            {!matchesQuery && <p className={styles.staleNotice}><CircleAlert size={17} aria-hidden="true" />La lectura corresponde al identificador anterior.</p>}
            <section className={styles.readiness} data-tone={statusTone(resolveTone(result))}>
              <div className={styles.readinessTitle}>
                {result.deliveryStatus?.ready ? <ShieldCheck size={25} aria-hidden="true" /> : <CircleAlert size={25} aria-hidden="true" />}
                <div><h3>{readiness.title}</h3><p>{readiness.eyebrow}</p></div>
              </div>
              <p>{readiness.detail}</p>
            </section>
            <dl className={styles.deviceFacts}>
              <div><dt>Estado remoto</dt><dd>{compactText(result.deviceState, "Sin estado")}</dd></div>
              <div><dt>Servicio</dt><dd>{compactText(result.serviceDetails || snapshot?.serviceDetails, "Sin información")}</dd></div>
              <div><dt>Último contacto</dt><dd>{formatoFecha(snapshot?.lastCheckIn || null)}</dd></div>
            </dl>
          </div> : <div className={styles.empty}>
            <span className={styles.emptyIcon}><Smartphone size={48} strokeWidth={1.4} aria-hidden="true" /><Search size={22} aria-hidden="true" /></span>
            <h3>Todo empieza con una consulta</h3>
            <p>Busca un equipo para ver su estado de entrega y las acciones disponibles.</p>
            <span className={styles.emptyNote}><ShieldCheck size={16} aria-hidden="true" />Consultar no modifica el equipo.</span>
          </div>}
        </Card>

        <Card className={styles.actionsCard}>
          <div className={styles.sectionHeader}><h2>Gestionar equipo</h2><Smartphone size={19} aria-hidden="true" /></div>
          <div className={styles.actionBody}>
            <p id="equality-action-hint" className={styles.actionHint}>{actionHint}</p>
            <Button variant="primary" className={styles.actionButton} disabled={busy || !canOperate} aria-describedby="equality-action-hint" onClick={() => requestAction("enroll")}>
              <PackageCheck size={20} aria-hidden="true" /><span>Inscribir equipo</span><ArrowUpRight size={17} aria-hidden="true" />
            </Button>
            {canAdmin && <Button variant="secondary" className={styles.actionButton} disabled={busy || !canOperate} aria-describedby="equality-action-hint" onClick={() => requestAction("unlock")}>
              <UnlockKeyhole size={20} aria-hidden="true" /><span>Desbloquear equipo</span><ArrowUpRight size={17} aria-hidden="true" />
            </Button>}
          </div>
          {canAdmin && <details className={styles.sensitiveActions}>
            <summary><LockKeyhole size={17} aria-hidden="true" /><span>Acciones sensibles</span><ChevronDown size={18} aria-hidden="true" /></summary>
            <div><p>Confirma el equipo antes de bloquearlo o finalizar su servicio.</p>
              <Button variant="danger" className={styles.actionButton} disabled={busy || !canOperate} aria-describedby="equality-action-hint" onClick={() => requestAction("lock")}><LockKeyhole size={18} aria-hidden="true" />Bloquear equipo</Button>
              <Button variant="secondary" className={styles.actionButton} disabled={busy || !canOperate} aria-describedby="equality-action-hint" onClick={() => requestAction("release")}><ShieldCheck size={18} aria-hidden="true" />Liberar equipo</Button>
            </div>
          </details>}
        </Card>
      </div>

      {result && <Card className={styles.diagnostics}>
        <details>
          <summary><Server size={19} aria-hidden="true" /><span>Detalle técnico</span><span className={styles.diagnosticSubtitle}>Diagnóstico y respuesta remota</span><ChevronDown size={19} aria-hidden="true" /></summary>
          <div className={styles.diagnosticBody}>
            <dl className={styles.diagnosticGrid}>{diagnostics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            <div className={styles.transitionQueue}><h3>Cola de transiciones</h3>
              {snapshot?.transitionQueue?.length ? snapshot.transitionQueue.map((item, index) => <StatusPill key={`${index}-${item}`}>{item}</StatusPill>) : <p>Sin transiciones pendientes.</p>}
            </div>
            <div className={styles.rawResponse}><h3>Respuesta remota</h3><pre tabIndex={0} aria-label="Respuesta remota de Equality">{prettyJson(result.response)}</pre></div>
          </div>
        </details>
      </Card>}
      <ConfirmDialog open={Boolean(confirmation)} title={confirmation ? actionCopy[confirmation.action].label : "Confirmar acción"}
        description={confirmation ? `${actionCopy[confirmation.action].description} IMEI / Device UID: ${confirmation.deviceUid}.` : ""}
        confirmLabel={confirmation ? actionCopy[confirmation.action].label : "Confirmar"}
        busy={processing !== null} danger={confirmation?.action === "lock" || confirmation?.action === "release"}
        onCancel={() => { if (!actionInFlight.current) setConfirmation(null); }}
        onConfirm={() => { if (confirmation) void ejecutarAccion(confirmation.action, confirmation.deviceUid); }}
      />
    </main>
  );
}
