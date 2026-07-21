"use client";

import { useMemo, useState, type ReactNode } from "react";

type EqualityAction = "enroll" | "lock" | "release" | "unlock";

type NoticeTone = "amber" | "emerald" | "red" | "slate";

type Notice = {
  text: string;
  tone: NoticeTone;
};

type EqualityLookup = {
  configured: boolean;
  canManage: boolean;
  deviceUid: string;
  probe: boolean;
  response: Record<string, unknown> | null;
  resultCode: string | null;
  resultMessage: string | null;
  remoteStatusCode: number | null;
  deviceState: string | null;
  serviceDetails: string | null;
  deliveryStatus: {
    detail: string;
    label: string;
    ready: boolean;
    tone: "amber" | "emerald" | "red" | "sky" | "slate";
  } | null;
};

type ResultTone = "amber" | "emerald" | "red" | "slate";

type CommercialResult = {
  detail: string;
  label: string;
  tone: ResultTone;
};

function sanitizeDeviceInput(value: string) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function noticeClasses(tone: NoticeTone) {
  switch (tone) {
    case "emerald":
      return "border-[#bfe66f] bg-[#f5fadf] text-[#4f6f0c]";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "red":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function resultClasses(tone: ResultTone) {
  switch (tone) {
    case "emerald":
      return "border-[#bfe66f] bg-[#f5fadf] text-[#111820]";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-950";
    case "red":
      return "border-red-200 bg-red-50 text-red-950";
    default:
      return "border-slate-200 bg-slate-50 text-slate-800";
  }
}

function friendlyStateLabel(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return "Sin consulta";
  }

  if (normalized.includes("ready for use")) {
    return "Listo";
  }

  if (normalized.includes("active")) {
    return "Activo";
  }

  if (normalized.includes("enrolled")) {
    return "Inscrito";
  }

  if (normalized.includes("locked")) {
    return "Bloqueado";
  }

  if (normalized.includes("released")) {
    return "Liberado";
  }

  return "En revision";
}

function friendlyServiceLabel(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return "Sin confirmar";
  }

  if (normalized.includes("postpaid") || normalized.includes("devicefinancing")) {
    return "Financiacion activa";
  }

  return "Servicio encontrado";
}

function getCommercialResult(result: EqualityLookup | null): CommercialResult {
  if (!result) {
    return {
      label: "Sin consulta",
      tone: "slate",
      detail: "Digita el IMEI y consulta el estado del equipo.",
    };
  }

  if (result.deliveryStatus?.ready) {
    return {
      label: "Listo para entregar",
      tone: "emerald",
      detail: "El equipo ya esta validado. Puedes volver a la fabrica y cerrar el credito.",
    };
  }

  const label = String(result.deliveryStatus?.label || result.deviceState || "").toLowerCase();

  if (label.includes("locked") || label.includes("bloque")) {
    return {
      label: "Equipo bloqueado",
      tone: "red",
      detail: "Este equipo aparece bloqueado. Revisa antes de entregarlo.",
    };
  }

  if (label.includes("enrolled") || label.includes("inscrito")) {
    return {
      label: "Inscrito, falta validar",
      tone: "amber",
      detail: "El equipo ya fue inscrito. Ahora valida entrega cuando el celular sincronice.",
    };
  }

  if (result.resultMessage && !result.configured) {
    return {
      label: "Falta conexion",
      tone: "red",
      detail: "Zero Touch aun no esta conectado para operar este equipo.",
    };
  }

  return {
    label: "Pendiente",
    tone: "amber",
    detail: "Todavia no esta confirmado para entregar. Intenta validar de nuevo en unos minutos.",
  };
}

function actionNotice(action: EqualityAction, result: EqualityLookup | null) {
  if (action === "enroll") {
    return "Inscripcion enviada. Ahora valida la entrega.";
  }

  if (action === "lock") {
    return "Bloqueo enviado.";
  }

  if (action === "unlock") {
    return "Desbloqueo enviado.";
  }

  if (action === "release") {
    return "Liberacion enviada.";
  }

  return getCommercialResult(result).detail;
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });

  const data = (await response.json().catch(() => null)) as
    | (T & {
        error?: string;
        resultMessage?: string;
        ok?: boolean;
      })
    | null;

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
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
    danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
    primary: "bg-[#111820] text-white hover:bg-[#05070a]",
    secondary: "border border-[#ccd7dd] bg-white text-[#111820] hover:bg-[#f7f9fb]",
    success: "bg-[#a6d51f] text-[#111820] hover:bg-[#b8eb24]",
    warning: "bg-amber-500 text-white hover:bg-amber-600",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-70",
        tones[tone],
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default function DeviceOperationsConsole({
  canAdmin,
}: {
  canAdmin: boolean;
}) {
  const [deviceInput, setDeviceInput] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [equalityResult, setEqualityResult] = useState<EqualityLookup | null>(null);

  const normalizedInput = sanitizeDeviceInput(deviceInput);
  const commercialResult = useMemo(
    () => getCommercialResult(equalityResult),
    [equalityResult]
  );

  const lookupEquality = async (target = normalizedInput) => {
    if (!target) {
      throw new Error("Ingresa el IMEI del equipo.");
    }

    const result = await requestJson<EqualityLookup>(
      `/api/equality?deviceUid=${encodeURIComponent(target)}`
    );

    if (!result.ok) {
      throw new Error(result.data?.error || "No se pudo consultar el equipo.");
    }

    if (!result.data) {
      throw new Error("No se recibio respuesta del equipo.");
    }

    setEqualityResult(result.data);
    return result.data;
  };

  const consultar = async () => {
    if (!normalizedInput) {
      setNotice({
        text: "Ingresa primero el IMEI del equipo.",
        tone: "red",
      });
      return;
    }

    try {
      setProcessing("query");
      setNotice(null);
      const result = await lookupEquality(normalizedInput);
      const readable = getCommercialResult(result);
      setNotice({
        text: readable.detail,
        tone: readable.tone === "emerald" ? "emerald" : "amber",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el equipo.",
        tone: "red",
      });
    } finally {
      setProcessing(null);
    }
  };

  const runEqualityAction = async (action: EqualityAction) => {
    if (!normalizedInput) {
      setNotice({
        text: "Ingresa primero el IMEI del equipo.",
        tone: "red",
      });
      return;
    }

    try {
      setProcessing(`equality-${action}`);
      setNotice(null);

      const result = await requestJson<{
        action: string;
        ok?: boolean;
        resultMessage?: string;
      }>("/api/equality", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          deviceUid: normalizedInput,
        }),
      });

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo ejecutar la accion.");
      }

      const query = await lookupEquality(normalizedInput);
      const readable = getCommercialResult(query);

      setNotice({
        text: actionNotice(action, query),
        tone:
          action === "lock"
            ? "amber"
            : action === "enroll" || readable.tone === "emerald"
              ? "emerald"
              : "amber",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo ejecutar la accion.",
        tone: "red",
      });
    } finally {
      setProcessing(null);
    }
  };

  return (
    <section className="rounded-lg border border-[#d8dee5] bg-white shadow-[0_10px_28px_rgba(16,24,40,0.06)]">
      <div className="grid lg:grid-cols-[1fr_420px]">
        <div className="p-6">
          <span className="inline-flex rounded-full border border-[#d9ec9d] bg-[#f5fadf] px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-[#5c7a13]">
            Operacion Zero Touch
          </span>
          <h2 className="mt-4 text-3xl font-black tracking-tight text-[#111820]">
            Consultar equipo
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#667085]">
            Ingresa el IMEI para consultar, inscribir o validar la entregabilidad del dispositivo.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
            <input
              value={deviceInput}
              onChange={(event) =>
                setDeviceInput(sanitizeDeviceInput(event.target.value))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void consultar();
                }
              }}
              placeholder="IMEI del equipo"
              className="h-12 w-full rounded-lg border border-[#ccd7dd] bg-white px-4 text-base text-[#111820] outline-none transition focus:border-[#a6d51f] focus:ring-4 focus:ring-[#a6d51f]/15"
            />

            <ActionButton
              tone="primary"
              disabled={processing !== null}
              onClick={() => void consultar()}
            >
              {processing === "query" ? "Consultando..." : "Consultar"}
            </ActionButton>
          </div>

          {notice && (
            <div
              className={[
                "mt-4 rounded-lg border px-4 py-4 text-sm font-bold",
                noticeClasses(notice.tone),
              ].join(" ")}
            >
              {notice.text}
            </div>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:max-w-lg">
            <ActionButton
              tone="success"
              disabled={processing !== null}
              onClick={() => void runEqualityAction("enroll")}
            >
              {processing === "equality-enroll" ? "Inscribiendo..." : "Inscribir"}
            </ActionButton>

            <ActionButton
              tone="primary"
              disabled={processing !== null}
              onClick={() => void consultar()}
            >
              {processing === "query" ? "Validando..." : "Validar entrega"}
            </ActionButton>
          </div>
        </div>

        <article
          className={[
            "border-t p-6 lg:border-l lg:border-t-0",
            resultClasses(commercialResult.tone),
          ].join(" ")}
        >
          <p className="text-[11px] font-black uppercase tracking-[0.18em] opacity-70">
            Resultado
          </p>
          <h3 className="mt-3 text-3xl font-black tracking-tight">
            {commercialResult.label}
          </h3>
          <p className="mt-3 text-sm leading-6">{commercialResult.detail}</p>

          <div className="mt-5 grid gap-3">
            <div className="rounded-lg border border-white/70 bg-white/75 px-4 py-3">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] opacity-60">
                Equipo
              </p>
              <p className="mt-1 text-lg font-black">
                {friendlyStateLabel(equalityResult?.deviceState)}
              </p>
            </div>
            <div className="rounded-lg border border-white/70 bg-white/75 px-4 py-3">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] opacity-60">
                Servicio
              </p>
              <p className="mt-1 text-lg font-black">
                {friendlyServiceLabel(equalityResult?.serviceDetails)}
              </p>
            </div>
          </div>
        </article>
      </div>

      {canAdmin && (
        <details className="border-t border-[#d8dee5] bg-[#f7f9fb] px-6 py-4">
          <summary className="cursor-pointer text-sm font-black text-[#111820]">
            Acciones especiales
          </summary>
          <div className="mt-4 flex flex-wrap gap-3">
            <ActionButton
              tone="danger"
              disabled={processing !== null}
              onClick={() => void runEqualityAction("lock")}
            >
              {processing === "equality-lock" ? "Bloqueando..." : "Bloquear"}
            </ActionButton>
            <ActionButton
              tone="success"
              disabled={processing !== null}
              onClick={() => void runEqualityAction("unlock")}
            >
              {processing === "equality-unlock" ? "Desbloqueando..." : "Desbloquear"}
            </ActionButton>
            <ActionButton
              tone="warning"
              disabled={processing !== null}
              onClick={() => void runEqualityAction("release")}
            >
              {processing === "equality-release" ? "Liberando..." : "Liberar"}
            </ActionButton>
          </div>
        </details>
      )}

      {canAdmin && equalityResult && (
        <details className="border-t border-[#d8dee5] bg-white px-6 py-4 text-sm text-[#667085]">
          <summary className="cursor-pointer font-black text-[#111820]">
            Ver detalle avanzado
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <p>IMEI: {equalityResult.deviceUid || "-"}</p>
            <p>Codigo: {equalityResult.resultCode || "-"}</p>
            <p>Estado recibido: {equalityResult.deviceState || "-"}</p>
            <p>Servicio recibido: {equalityResult.serviceDetails || "-"}</p>
            <p className="sm:col-span-2">
              Mensaje recibido: {equalityResult.resultMessage || "-"}
            </p>
          </div>
        </details>
      )}
    </section>
  );
}
