"use client";

import Link from "next/link";
import { useState } from "react";

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

function sanitizeDeviceInput(value: string) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function requestToneClasses(tone: NoticeTone) {
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

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });

  const data = (await response.json().catch(() => null)) as T & {
    error?: string;
    resultMessage?: string;
    ok?: boolean;
  };

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
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone?: "danger" | "primary" | "secondary" | "success" | "warning";
}) {
  const tones = {
    danger: "bg-red-600 text-white hover:bg-red-700",
    primary: "bg-slate-950 text-white hover:bg-slate-800",
    secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
    warning: "bg-amber-500 text-white hover:bg-amber-600",
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

  const lookupEquality = async (target = normalizedInput) => {
    if (!target) {
      throw new Error("Debes ingresar un deviceUid o IMEI para consultar Zero Touch.");
    }

    const result = await requestJson<EqualityLookup>(
      `/api/equality?deviceUid=${encodeURIComponent(target)}`
    );

    if (!result.ok) {
      throw new Error(result.data?.error || "No se pudo consultar Equality Zero Touch.");
    }

    setEqualityResult(result.data);
    return result.data;
  };

  const consultar = async () => {
    if (!normalizedInput) {
      setNotice({
        text: "Ingresa primero un IMEI o deviceUid.",
        tone: "red",
      });
      return;
    }

    try {
      setProcessing("query");
      setNotice(null);
      const result = await lookupEquality(normalizedInput);
      setNotice({
        text:
          result.deliveryStatus?.detail ||
          result.resultMessage ||
          "Consulta completada en Equality Zero Touch.",
        tone: result.deliveryStatus?.ready ? "emerald" : "amber",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el dispositivo.",
        tone: "red",
      });
    } finally {
      setProcessing(null);
    }
  };

  const runEqualityAction = async (action: EqualityAction) => {
    if (!normalizedInput) {
      setNotice({
        text: "Debes ingresar un deviceUid o IMEI para operar en Zero Touch.",
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
        throw new Error(result.data?.error || "No se pudo ejecutar la accion en Zero Touch.");
      }

      const query = await lookupEquality(normalizedInput);

      setNotice({
        text:
          query.deliveryStatus?.detail ||
          result.data?.resultMessage ||
          (action === "enroll"
            ? "Inscripcion enviada a Zero Touch correctamente."
            : "Accion enviada a Zero Touch correctamente."),
        tone:
          action === "enroll" && query.deliveryStatus?.ready
            ? "emerald"
            : result.data?.ok === false
              ? "amber"
              : "emerald",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo ejecutar la accion en Zero Touch.",
        tone: "red",
      });
    } finally {
      setProcessing(null);
    }
  };

  return (
    <section className="mt-8 rounded-[32px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
            Operaciones Zero Touch
          </div>
          <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
            Una sola integracion, un solo flujo
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            Este portal ahora opera solo con Equality Zero Touch. El boton
            `Inscribir equipo` ya cubre la alta completa del equipo y luego puedes
            verificar si queda 100% entregable.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/dashboard/creditos"
            className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Fabrica de creditos
          </Link>
          <Link
            href="/dashboard/equality"
            className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Consola Equality
          </Link>
        </div>
      </div>

      <div className="mt-6">
        <label className="mb-2 block text-sm font-semibold text-slate-700">
          IMEI o deviceUid
        </label>
        <input
          value={deviceInput}
          onChange={(event) => setDeviceInput(sanitizeDeviceInput(event.target.value))}
          placeholder="Ejemplo: 358240051111110"
          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
        />
        <p className="mt-2 text-sm text-slate-500">
          Usa un solo dato de entrada y el portal lo consulta directamente en
          Zero Touch.
        </p>
      </div>

      {notice && (
        <div
          className={[
            "mt-5 rounded-2xl border px-4 py-4 text-sm font-medium",
            requestToneClasses(notice.tone),
          ].join(" ")}
        >
          {notice.text}
        </div>
      )}

      <div className="mt-6 rounded-[28px] border border-[#e6dece] bg-white/90 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Equality Zero Touch
            </p>
            <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              Inscripcion y control remoto
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {canAdmin
                ? "Flujo recomendado: `Consultar`, `Inscribir equipo` y luego, si hace falta, `Bloquear`, `Desbloquear` o `Liberar`."
                : "Flujo de vendedor: `Consultar`, `Inscribir equipo` y confirmar si el equipo ya se puede entregar."}
            </p>
          </div>

          <span className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Alta completa
          </span>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <ActionButton
            tone="primary"
            disabled={processing !== null}
            onClick={() => void consultar()}
          >
            {processing === "query" ? "Consultando..." : "Consultar"}
          </ActionButton>

          <ActionButton
            tone="success"
            disabled={processing !== null}
            onClick={() => void runEqualityAction("enroll")}
          >
            {processing === "equality-enroll" ? "Inscribiendo..." : "Inscribir equipo"}
          </ActionButton>

          {canAdmin && (
            <>
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
            </>
          )}
        </div>

        {!canAdmin && (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
            Vista de vendedor: esta consola se limita a inscripcion y verificacion
            de entregabilidad.
          </div>
        )}

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Device UID
            </p>
            <p className="mt-2 text-lg font-black text-slate-950">
              {equalityResult?.deviceUid || normalizedInput || "-"}
            </p>
          </div>

          <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Estado remoto
            </p>
            <p className="mt-2 text-lg font-black text-slate-950">
              {equalityResult?.deviceState || "Sin consulta"}
            </p>
          </div>

          <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Servicio
            </p>
            <p className="mt-2 text-lg font-black text-slate-950">
              {equalityResult?.serviceDetails || "Sin consulta"}
            </p>
          </div>

          <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Entregabilidad
            </p>
            <p className="mt-2 text-lg font-black text-slate-950">
              {equalityResult?.deliveryStatus?.ready
                ? "Si se puede entregar"
                : equalityResult?.deliveryStatus?.label || "Pendiente"}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Lectura actual
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {equalityResult?.deliveryStatus?.detail ||
              equalityResult?.resultMessage ||
              "Todavia no hay una consulta reciente de Zero Touch para este equipo."}
          </p>
        </div>
      </div>
    </section>
  );
}
