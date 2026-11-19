"use client";

import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Input, Select } from "@/app/_components/finser-ui";
import { MAX_CREDIT_INSTALLMENTS, PAYMENT_FREQUENCY_OPTIONS } from "@/lib/credit-factory";

type CorrectionFields = {
  plazoMeses: number;
  cuotasPagadas: number;
  valorCuota: number;
  frecuenciaPago: string;
  fechaProximaCuota: string;
  motivo: string;
};
type CorrectionRequest = CorrectionFields & {
  accion: "CONFIRMAR";
  quoteHash: string;
  idempotencyKey: string;
};
type CorrectionForm = Record<keyof CorrectionFields, string>;
type NextInstallment = { numero: number; fechaVencimiento: string; valor?: number; valorProgramado?: number };
type CorrectionQuote = CorrectionFields & {
  montoCreditoActualizado: number;
  totalPlanNominal: number;
  totalAbonadoAlCorte: number;
  diferenciaHistorica: number;
  saldoPendiente: number;
  cuotasPendientes: number;
  proximaCuota: NextInstallment;
};
type CorrectionContext = {
  ok: boolean;
  eligible: boolean;
  motivo?: string;
  creditoId: number;
  plazoMeses: number;
  frecuenciaPago: string;
  valorCuota: number;
  proximaCuota: NextInstallment | null;
};
const EMPTY_FORM: CorrectionForm = {
  plazoMeses: "", cuotasPagadas: "", valorCuota: "", frecuenciaPago: "QUINCENAL", fechaProximaCuota: "", motivo: "",
};

function money(value: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 2 }).format(value);
}
function date(value: string) { return value.split("-").reverse().join("/"); }
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function buildHistoricalCorrectionPayload(form: CorrectionForm): CorrectionFields {
  const plazoMeses = Number(form.plazoMeses);
  const cuotasPagadas = Number(form.cuotasPagadas);
  const amount = form.valorCuota.replace(/[.\s$]/g, "");
  const valorCuota = /^\d+$/.test(amount) ? Number(amount) : NaN;
  if (!Number.isSafeInteger(plazoMeses) || plazoMeses < 1 || plazoMeses > MAX_CREDIT_INSTALLMENTS) {
    throw new Error(`Indica entre 1 y ${MAX_CREDIT_INSTALLMENTS} cuotas totales.`);
  }
  if (!form.cuotasPagadas.trim() || !Number.isSafeInteger(cuotasPagadas) || cuotasPagadas < 0 || cuotasPagadas >= plazoMeses) {
    throw new Error("Las cuotas reconocidas como pagadas deben ser menores que el plazo total.");
  }
  if (!Number.isSafeInteger(valorCuota) || valorCuota <= 0 || valorCuota >= 1e10) throw new Error("Indica una cuota válida en pesos enteros.");
  if (!PAYMENT_FREQUENCY_OPTIONS.some(option => option.value === form.frecuenciaPago)) throw new Error("Selecciona una frecuencia válida.");
  if (!validDate(form.fechaProximaCuota)) throw new Error("Indica una fecha válida para la próxima cuota pendiente.");
  if (form.frecuenciaPago === "QUINCENAL" && ![2, 17].includes(Number(form.fechaProximaCuota.slice(-2)))) {
    throw new Error("El calendario quincenal vence los días 2 y 17. Selecciona uno de esos días.");
  }
  const motivo = form.motivo.trim();
  if (motivo.length < 10 || motivo.length > 1000) throw new Error("Describe el motivo de la corrección entre 10 y 1000 caracteres.");
  return { plazoMeses, cuotasPagadas, valorCuota, frecuenciaPago: form.frecuenciaPago, fechaProximaCuota: form.fechaProximaCuota, motivo };
}

function validateQuote(value: unknown, fields: CorrectionFields): CorrectionQuote {
  const q = value as CorrectionQuote | null;
  const amounts = [q?.montoCreditoActualizado, q?.totalPlanNominal, q?.totalAbonadoAlCorte, q?.saldoPendiente];
  if (!q || amounts.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
      typeof q.diferenciaHistorica !== "number" || !Number.isFinite(q.diferenciaHistorica) ||
      q.plazoMeses !== fields.plazoMeses || q.cuotasPagadas !== fields.cuotasPagadas || q.valorCuota !== fields.valorCuota ||
      q.frecuenciaPago !== fields.frecuenciaPago || q.cuotasPendientes !== fields.plazoMeses - fields.cuotasPagadas ||
      q.proximaCuota?.numero !== fields.cuotasPagadas + 1 || q.proximaCuota.fechaVencimiento !== fields.fechaProximaCuota ||
      (q.proximaCuota.valor ?? q.proximaCuota.valorProgramado) !== fields.valorCuota ||
      Math.round(q.totalPlanNominal * 100) !== Math.round(fields.plazoMeses * fields.valorCuota * 100) ||
      Math.round(q.diferenciaHistorica * 100) !== Math.round((q.totalAbonadoAlCorte - fields.cuotasPagadas * fields.valorCuota) * 100) ||
      Math.round(q.saldoPendiente * 100) !== Math.round(q.cuotasPendientes * fields.valorCuota * 100) ||
      Math.round(q.montoCreditoActualizado * 100) !== Math.round((q.totalAbonadoAlCorte + q.saldoPendiente) * 100)) {
    throw new Error("La previsualización no coincide con el ajuste solicitado. Consulta nuevamente el crédito.");
  }
  return q;
}

export function historicalCorrectionStorageKey(creditId: number) { return `finser:historical-plan-correction:${creditId}`; }
export function readHistoricalCorrectionPending(raw: string | null, creditId: number): CorrectionRequest | null {
  if (!raw) return null;
  const entry = JSON.parse(raw) as { version?: number; creditId?: number; request?: CorrectionRequest };
  const request = entry.request;
  if (entry.version !== 1 || entry.creditId !== creditId || !request || request.accion !== "CONFIRMAR" ||
      !/^[a-f0-9]{64}$/.test(request.quoteHash) || !/^[A-Za-z0-9_-]{16,100}$/.test(request.idempotencyKey)) throw new Error("Confirmación pendiente inválida.");
  const fields = buildHistoricalCorrectionPayload({ plazoMeses: String(request.plazoMeses), cuotasPagadas: String(request.cuotasPagadas),
    valorCuota: String(request.valorCuota), frecuenciaPago: request.frecuenciaPago, fechaProximaCuota: request.fechaProximaCuota, motivo: request.motivo });
  return { ...fields, accion: "CONFIRMAR", quoteHash: request.quoteHash, idempotencyKey: request.idempotencyKey };
}

export default function CreditHistoricalPlanCorrectionPanel({ creditId, revisionKey, disabled = false, onBusyChange, onApplied }: {
  creditId: number;
  revisionKey: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onApplied: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<CorrectionContext | null>(null);
  const [form, setForm] = useState<CorrectionForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [quote, setQuote] = useState<CorrectionQuote | null>(null);
  const [quotedFields, setQuotedFields] = useState<CorrectionFields | null>(null);
  const [quoteHash, setQuoteHash] = useState("");
  const [differenceAccepted, setDifferenceAccepted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<CorrectionRequest | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const inFlight = useRef(false);
  const generation = useRef(0);
  const endpoint = `/api/creditos/${creditId}/correccion-plan-historico`;

  useEffect(() => { onBusyChange?.(loading || working); return () => onBusyChange?.(false); }, [loading, working, onBusyChange]);
  useEffect(() => {
    const current = ++generation.current;
    inFlight.current = false; setWorking(false); setLoading(false);
    setContext(null); setQuote(null); setQuotedFields(null); setQuoteHash(""); setDifferenceAccepted(false); setConfirmOpen(false);
    setError(""); setSuccess(""); setForm(EMPTY_FORM); setPending(null); setRecoveryBlocked(false);
    if (!expanded) return;
    try { setPending(readHistoricalCorrectionPending(window.sessionStorage.getItem(historicalCorrectionStorageKey(creditId)), creditId)); }
    catch { setRecoveryBlocked(true); setError("No se pudo recuperar la confirmación pendiente. Verifica la revisión con administración antes de preparar otra corrección."); }
    const controller = new AbortController();
    setLoading(true);
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (current !== generation.current) return;
      if (!response.ok || data?.ok !== true || data.creditoId !== creditId || typeof data.eligible !== "boolean") throw new Error(data?.error || "No se pudo consultar el crédito histórico.");
      setContext(data as CorrectionContext);
      if (data.eligible) setForm({ ...EMPTY_FORM, plazoMeses: String(data.plazoMeses), cuotasPagadas: data.proximaCuota ? String(data.proximaCuota.numero - 1) : "",
        valorCuota: String(data.valorCuota), frecuenciaPago: data.frecuenciaPago, fechaProximaCuota: data.proximaCuota?.fechaVencimiento || "" });
    }).catch(reason => { if (!controller.signal.aborted && current === generation.current) setError(reason instanceof Error ? reason.message : "No se pudo consultar el crédito."); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current = current + 1; controller.abort(); };
  }, [creditId, revisionKey, expanded, endpoint]);

  function update(field: keyof CorrectionForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
    setQuote(null); setQuotedFields(null); setQuoteHash(""); setDifferenceAccepted(false); setConfirmOpen(false); setError(""); setSuccess("");
  }
  async function preview() {
    if (inFlight.current || disabled || pending || recoveryBlocked || !context?.eligible) return;
    const current = generation.current;
    try {
      const fields = buildHistoricalCorrectionPayload(form);
      inFlight.current = true; setWorking(true); setError(""); setSuccess(""); setQuote(null); setQuotedFields(null); setQuoteHash(""); setDifferenceAccepted(false);
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, accion: "PREVISUALIZAR" }) });
      const data = await response.json();
      if (current !== generation.current) return;
      if (!response.ok || data?.ok !== true || !/^[a-f0-9]{64}$/.test(data.quoteHash || "")) throw new Error(data?.error || "No se pudo previsualizar la corrección.");
      setQuote(validateQuote(data.quote, fields)); setQuotedFields(fields); setQuoteHash(data.quoteHash);
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : "No se pudo previsualizar."); }
    finally { if (current === generation.current) { inFlight.current = false; setWorking(false); } }
  }
  async function confirm(replay?: CorrectionRequest) {
    if (inFlight.current || disabled || recoveryBlocked) return;
    if (!replay && (!quote || !quotedFields || !quoteHash || (quote.diferenciaHistorica > 0 && !differenceAccepted))) return;
    const request = replay || { ...quotedFields!, accion: "CONFIRMAR" as const, quoteHash, idempotencyKey: crypto.randomUUID() };
    const current = generation.current;
    let applied = false;
    try {
      const key = historicalCorrectionStorageKey(creditId);
      const saved = JSON.stringify({ version: 1, creditId, request });
      window.sessionStorage.setItem(key, saved);
      if (window.sessionStorage.getItem(key) !== saved) throw new Error("No se pudo conservar la confirmación de forma segura. No se envió el ajuste.");
      inFlight.current = true; setPending(request); setWorking(true); setError(""); setConfirmOpen(false);
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const data = await response.json();
      if (!response.ok || data?.ok !== true || data.aplicado !== true) {
        if ([400, 403, 404, 409, 422].includes(response.status) && typeof data?.error === "string") {
          window.sessionStorage.removeItem(key);
          if (current === generation.current) { setPending(null); setQuote(null); setQuotedFields(null); setQuoteHash(""); }
          throw new Error(data?.error || "La corrección no se guardó. Consulta y previsualiza nuevamente el crédito.");
        }
        throw new Error("La respuesta no confirma el resultado. Verifica la corrección pendiente antes de intentar otra.");
      }
      applied = true;
      window.sessionStorage.removeItem(key);
      if (current !== generation.current) return;
      setPending(null); setQuote(null); setQuotedFields(null); setQuoteHash(""); setSuccess("Corrección aplicada. Los recibos y movimientos de caja se conservaron.");
      try { await onApplied(); } catch { setError("La corrección quedó aplicada. Actualiza el expediente para consultar el plan vigente."); }
    } catch (reason) {
      if (current === generation.current) setError(applied ? "La corrección quedó aplicada. Actualiza el expediente para consultarla." : reason instanceof Error ? reason.message : "No se pudo confirmar el resultado. Verifica la operación pendiente.");
    } finally { if (current === generation.current) { inFlight.current = false; setWorking(false); } }
  }
  const locked = disabled || loading || working || Boolean(pending) || recoveryBlocked;

  return <section className="mt-4 border-t border-[var(--fp-border)] pt-4" aria-label="Corrección de plan histórico">
    <Button variant="secondary" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} disabled={working}>
      {expanded ? "Cerrar corrección de plan histórico" : "Corregir plan histórico"}
    </Button>
    {expanded ? <div className="mt-4 space-y-4">
      <p className="text-sm text-[var(--fp-muted)]">Reconoce las cuotas anteriores y programa las pendientes. Los recibos y movimientos de caja existentes se conservan.</p>
      {loading ? <p role="status">Consultando el crédito…</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--fp-danger)]">{error}</p> : null}
      {success ? <p role="status" className="text-sm text-[var(--fp-graphite)]">{success}</p> : null}
      {pending ? <div className="space-y-3 rounded-lg bg-[var(--fp-amber-soft)] p-4">
        <p className="text-sm">Hay una confirmación pendiente de verificar. El reintento consulta o completa exactamente la misma revisión, sin crear otra.</p>
        <Button onClick={() => void confirm(pending)} disabled={working || disabled || recoveryBlocked}>{working ? "Verificando…" : "Verificar corrección pendiente"}</Button>
      </div> : null}
      {!loading && context && !context.eligible ? <p className="text-sm text-[var(--fp-muted)]">{context.motivo || "Este crédito no admite la corrección de un plan histórico."}</p> : null}
      {context?.eligible && !pending ? <>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-semibold">Cuotas totales<Input type="number" min={1} max={MAX_CREDIT_INSTALLMENTS} value={form.plazoMeses} disabled={locked} onChange={event => update("plazoMeses", event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-semibold">Cuotas reconocidas como pagadas<Input type="number" min={0} max={MAX_CREDIT_INSTALLMENTS - 1} value={form.cuotasPagadas} disabled={locked} onChange={event => update("cuotasPagadas", event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-semibold">Valor de cada cuota pendiente<Input inputMode="numeric" value={form.valorCuota} disabled={locked} onChange={event => update("valorCuota", event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-semibold">Frecuencia<Select value={form.frecuenciaPago} disabled={locked} onChange={event => update("frecuenciaPago", event.target.value)}>{PAYMENT_FREQUENCY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
          <label className="grid gap-2 text-sm font-semibold sm:col-span-2">Fecha de la próxima cuota pendiente<Input type="date" value={form.fechaProximaCuota} disabled={locked} onChange={event => update("fechaProximaCuota", event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-semibold sm:col-span-2">Motivo de la corrección<Input value={form.motivo} minLength={10} maxLength={1000} disabled={locked} onChange={event => update("motivo", event.target.value)} /></label>
        </div>
        {quote ? <div className="space-y-3 border-t border-[var(--fp-border)] pt-4" aria-label="Previsualización de la corrección">
          <h3 className="font-bold">Resultado antes de aplicar</h3>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt>Cuotas reconocidas como pagadas</dt><dd className="font-bold">{quote.cuotasPagadas}</dd></div>
            <div><dt>Cuotas pendientes</dt><dd className="font-bold">{quote.cuotasPendientes} de {money(quote.valorCuota)}</dd></div>
            <div><dt>Próxima cuota</dt><dd className="font-bold">{quote.proximaCuota.numero} · {date(quote.proximaCuota.fechaVencimiento)}</dd></div>
            <div><dt>Saldo pendiente</dt><dd className="font-bold">{money(quote.saldoPendiente)}</dd></div>
            <div><dt>Total nominal del plan</dt><dd className="font-bold">{money(quote.totalPlanNominal)}</dd></div>
            <div><dt>Recaudos anteriores conservados</dt><dd className="font-bold">{money(quote.totalAbonadoAlCorte)}</dd></div>
            <div><dt>Total operativo con los recaudos anteriores</dt><dd className="font-bold">{money(quote.montoCreditoActualizado)}</dd></div>
            <div><dt>Diferencia histórica registrada</dt><dd className="font-bold">{money(quote.diferenciaHistorica)}</dd></div>
          </dl>
          {quote.diferenciaHistorica > 0 ? <label className="flex gap-3 rounded-lg bg-[var(--fp-amber-soft)] p-4 text-sm"><input type="checkbox" checked={differenceAccepted} disabled={locked} onChange={event => setDifferenceAccepted(event.target.checked)} /><span>Reconozco la diferencia histórica de {money(quote.diferenciaHistorica)} y que no se aplicará a las cuotas futuras. Los recibos originales se conservan por su valor completo.</span></label> : null}
          <Button disabled={locked || (quote.diferenciaHistorica > 0 && !differenceAccepted)} onClick={() => setConfirmOpen(true)}>Revisar y confirmar corrección</Button>
        </div> : <Button onClick={() => void preview()} disabled={locked}>{working ? "Previsualizando…" : "Previsualizar corrección"}</Button>}
      </> : null}
      <ConfirmDialog open={confirmOpen} busy={working} title="Confirmar corrección del plan histórico" description={quote ? `Se reconocerán ${quote.cuotasPagadas} cuotas pagadas y quedarán ${quote.cuotasPendientes} cuotas de ${money(quote.valorCuota)}. La cuota ${quote.proximaCuota.numero} vence el ${date(quote.proximaCuota.fechaVencimiento)}. Los recibos y la caja se conservarán.${quote.diferenciaHistorica > 0 ? ` La diferencia histórica de ${money(quote.diferenciaHistorica)} no se aplicará a las cuotas futuras.` : ""}` : "Revisa el calendario antes de confirmar."} confirmLabel="Aplicar corrección" onCancel={() => { if (!working) setConfirmOpen(false); }} onConfirm={() => void confirm()} />
    </div> : null}
  </section>;
}
