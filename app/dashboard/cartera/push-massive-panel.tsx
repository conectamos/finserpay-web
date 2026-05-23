"use client";

import { useState } from "react";

type BulkPushFilter =
  | "MORA"
  | "TODOS_APP"
  | "VENCE_2_DIAS"
  | "VENCE_HOY"
  | "VENCE_MANANA";

type ManualPushPreset = "custom" | "efecty" | "internet" | "mora";

type PushSummary = {
  checked: number;
  failed: number;
  noToken: number;
  sent: number;
  targetCredits: number;
  wouldSend: number;
};

type PushResponse = {
  error?: string;
  ok?: boolean;
  summary?: PushSummary;
};

const FILTER_OPTIONS: Array<{ label: string; value: BulkPushFilter }> = [
  { label: "Clientes en mora", value: "MORA" },
  { label: "Vencen hoy", value: "VENCE_HOY" },
  { label: "Vencen manana", value: "VENCE_MANANA" },
  { label: "Vencen en 2 dias", value: "VENCE_2_DIAS" },
  { label: "Todos con app", value: "TODOS_APP" },
];

const PRESET_OPTIONS: Array<{ label: string; value: ManualPushPreset }> = [
  { label: "Cuota vencida", value: "mora" },
  { label: "Pago EFECTY", value: "efecty" },
  { label: "Mantener internet", value: "internet" },
  { label: "Personalizado", value: "custom" },
];

export default function PushMassivePanel() {
  const [filter, setFilter] = useState<BulkPushFilter>("MORA");
  const [preset, setPreset] = useState<ManualPushPreset>("mora");
  const [title, setTitle] = useState("FINSER PAY");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<PushSummary | null>(null);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState<"preview" | "send" | null>(null);

  const runPush = async (dryRun: boolean) => {
    if (preset === "custom" && !body.trim()) {
      setStatus("Escribe el mensaje personalizado antes de enviar.");
      return;
    }

    if (!dryRun) {
      const targetCount = preview?.wouldSend || preview?.targetCredits || 0;
      const confirmed = window.confirm(
        `Vas a enviar push masivo a ${targetCount} token(s) registrados.`
      );

      if (!confirmed) {
        return;
      }
    }

    try {
      setRunning(dryRun ? "preview" : "send");
      setStatus("");

      const response = await fetch("/api/creditos/push-manual", {
        body: JSON.stringify({
          body,
          dryRun,
          filter,
          mode: "bulk",
          preset,
          title,
        }),
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as PushResponse | null;

      if (!response.ok) {
        throw new Error(data?.error || "No se pudo procesar el envio push");
      }

      if (data?.summary) {
        setPreview(data.summary);
        setStatus(
          dryRun
            ? `Listo para enviar: ${data.summary.wouldSend}. Sin app: ${data.summary.noToken}.`
            : `Enviados: ${data.summary.sent}. Fallidos: ${data.summary.failed}. Sin app: ${data.summary.noToken}.`
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo enviar push");
    } finally {
      setRunning(null);
    }
  };

  return (
    <section className="mt-4 rounded-[26px] border border-[#cfe4de] bg-white p-4 shadow-[0_14px_36px_rgba(24,32,37,0.05)]">
      <div className="grid gap-4 xl:grid-cols-[280px_1fr_auto] xl:items-end">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
            Push clientes
          </p>
          <h2 className="mt-2 text-xl font-black tracking-tight text-[#20242a]">
            Envio por cartera
          </h2>
          <p className="mt-1 text-sm leading-5 text-[#687080]">
            Previsualiza antes de enviar.
          </p>
        </div>

        <div className="grid gap-3 lg:grid-cols-4">
          <label className="grid gap-2 text-sm font-semibold text-[#20242a]">
            Grupo
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as BulkPushFilter)}
              className="h-11 rounded-2xl border border-[#d7dce2] bg-white px-4 text-sm font-semibold outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
            >
              {FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm font-semibold text-[#20242a]">
            Mensaje
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value as ManualPushPreset)}
              className="h-11 rounded-2xl border border-[#d7dce2] bg-white px-4 text-sm font-semibold outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
            >
              {PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm font-semibold text-[#20242a]">
            Titulo
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-11 rounded-2xl border border-[#d7dce2] bg-white px-4 text-sm font-semibold outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
            />
          </label>

          <label className="grid gap-2 text-sm font-semibold text-[#20242a]">
            Personalizado
            <input
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Solo si eliges Personalizado"
              className="h-11 rounded-2xl border border-[#d7dce2] bg-white px-4 text-sm font-semibold outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2 xl:justify-end">
          <button
            type="button"
            onClick={() => void runPush(true)}
            disabled={running !== null}
            className="h-11 rounded-2xl border border-[#b9e5d3] bg-white px-4 text-sm font-black text-[#0f766e] transition hover:-translate-y-0.5 disabled:opacity-70"
          >
            {running === "preview" ? "Revisando..." : "Previsualizar"}
          </button>
          <button
            type="button"
            onClick={() => void runPush(false)}
            disabled={running !== null || !preview}
            className="h-11 rounded-2xl border border-[#145a5a] bg-[#145a5a] px-4 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:opacity-70"
          >
            {running === "send" ? "Enviando..." : "Enviar masivo"}
          </button>
        </div>
      </div>

      {preview ? (
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-2xl border border-[#d7dce2] bg-[#f8fbfa] px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#687080]">
              Creditos
            </p>
            <p className="mt-1 text-xl font-black">{preview.targetCredits}</p>
          </div>
          <div className="rounded-2xl border border-[#b9e5d3] bg-[#ecfdf5] px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#0f766e]">
              Con app
            </p>
            <p className="mt-1 text-xl font-black">{preview.wouldSend || preview.sent}</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-700">
              Sin app
            </p>
            <p className="mt-1 text-xl font-black">{preview.noToken}</p>
          </div>
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-red-700">
              Fallidos
            </p>
            <p className="mt-1 text-xl font-black">{preview.failed}</p>
          </div>
        </div>
      ) : null}

      {status ? (
        <p className="mt-4 rounded-2xl border border-[#d7dce2] bg-[#f8fbfa] px-4 py-3 text-sm font-semibold text-[#20242a]">
          {status}
        </p>
      ) : null}
    </section>
  );
}
