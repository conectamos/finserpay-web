"use client";

import { useState } from "react";
import { Eye, Megaphone, Send } from "lucide-react";

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
    <section className="h-full rounded-lg border border-[#d8dee6] bg-white p-5 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-[#0d766f]">
              <Megaphone className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <div>
              <p className="text-xs font-bold uppercase text-[#0d766f]">Push clientes</p>
              <h2 className="mt-1 text-xl font-black text-[#101828]">Gestion masiva</h2>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 lg:justify-end">
            <button
              type="button"
              onClick={() => void runPush(true)}
              disabled={running !== null}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#cce4e1] bg-white px-3 text-sm font-bold text-[#0d766f] transition hover:border-[#0d9488] hover:bg-[#f5fbfa] disabled:opacity-70"
            >
              <Eye className="h-4 w-4" strokeWidth={2} />
              {running === "preview" ? "Revisando..." : "Previsualizar"}
            </button>
            <button
              type="button"
              onClick={() => void runPush(false)}
              disabled={running !== null || !preview}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#17202b] px-3 text-sm font-bold text-white transition hover:bg-[#0d131c] disabled:opacity-50"
            >
              <Send className="h-4 w-4" strokeWidth={2} />
              {running === "send" ? "Enviando..." : "Enviar masivo"}
            </button>
          </div>
        </div>

        <div className="grid gap-3 border-t border-[#e4e9ef] pt-4 md:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[#344054]">
            Grupo
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as BulkPushFilter)}
              className="h-11 w-full min-w-0 rounded-lg border border-[#d0d7e0] bg-[#f7f9fb] px-3 text-sm font-semibold outline-none transition focus:border-[#0d9488] focus:bg-white focus:ring-4 focus:ring-[#0d9488]/10"
            >
              {FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[#344054]">
            Mensaje
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value as ManualPushPreset)}
              className="h-11 w-full min-w-0 rounded-lg border border-[#d0d7e0] bg-[#f7f9fb] px-3 text-sm font-semibold outline-none transition focus:border-[#0d9488] focus:bg-white focus:ring-4 focus:ring-[#0d9488]/10"
            >
              {PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[#344054]">
            Titulo
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-11 w-full min-w-0 rounded-lg border border-[#d0d7e0] bg-[#f7f9fb] px-3 text-sm font-semibold outline-none transition focus:border-[#0d9488] focus:bg-white focus:ring-4 focus:ring-[#0d9488]/10"
            />
          </label>

          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[#344054]">
            Personalizado
            <input
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Solo si eliges Personalizado"
              className="h-11 w-full min-w-0 rounded-lg border border-[#d0d7e0] bg-[#f7f9fb] px-3 text-sm font-semibold outline-none transition focus:border-[#0d9488] focus:bg-white focus:ring-4 focus:ring-[#0d9488]/10"
            />
          </label>
        </div>
      </div>

      {preview ? (
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-lg border border-[#d8dee6] bg-[#f7f9fb] px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#687080]">
              Creditos
            </p>
            <p className="mt-1 text-xl font-black">{preview.targetCredits}</p>
          </div>
          <div className="rounded-lg border border-[#b9e5d3] bg-[#ecfdf5] px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#0f766e]">
              Con app
            </p>
            <p className="mt-1 text-xl font-black">{preview.wouldSend || preview.sent}</p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-700">
              Sin app
            </p>
            <p className="mt-1 text-xl font-black">{preview.noToken}</p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-red-700">
              Fallidos
            </p>
            <p className="mt-1 text-xl font-black">{preview.failed}</p>
          </div>
        </div>
      ) : null}

      {status ? (
        <p className="mt-4 rounded-lg border border-[#d8dee6] bg-[#f8fbfa] px-4 py-3 text-sm font-semibold text-[#344054]">
          {status}
        </p>
      ) : null}
    </section>
  );
}
