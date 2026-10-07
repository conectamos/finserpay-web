"use client";

import { useEffect, useRef, useState } from "react";
import {PAYMENT_METHOD_OPTIONS} from "@/lib/payment-methods";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, Card, DataTable, Input, Select } from "@/app/_components/finser-ui";

type CapitalReconciliation = {
  capitalPendiente: number;
  tasaPeriodo: number;
  cuotaCredito: number;
  fianzaCuota: number;
  seguroCuota: number;
  numeroProximaCuota: number;
  fuente: string;
};

type PrincipalPaymentPayload = {
  valor: number;
  metodoPago: string;
  observacion: string;
  conciliacion?: CapitalReconciliation;
};

type PrincipalConfirmationRequest = PrincipalPaymentPayload & {
  accion: "CONFIRMAR";
  quoteHash: string;
  idempotencyKey: string;
};

export const principalPendingStorageKey = (creditId: number) => `finser-capital-pending-v1:${creditId}`;

function recoverPendingConfirmation(creditId: number): { request: PrincipalConfirmationRequest | null; error: string } {
  if (typeof window === "undefined") return { request: null, error: "" };
  try {
    const raw = window.sessionStorage.getItem(principalPendingStorageKey(creditId));
    if (!raw) return { request: null, error: "" };
    const stored = JSON.parse(raw);
    const request = stored?.request as PrincipalConfirmationRequest | undefined;
    if (stored?.version !== 1 || stored.creditId !== creditId || !request || request.accion !== "CONFIRMAR" ||
        !Number.isSafeInteger(request.valor) || request.valor <= 0 || typeof request.metodoPago !== "string" ||
        typeof request.observacion !== "string" || !/^[a-f0-9]{64}$/.test(request.quoteHash) ||
        !/^[A-Za-z0-9_-]{16,100}$/.test(request.idempotencyKey)) {
      throw new Error("Invalid pending confirmation");
    }
    // Keep only the exact replay payload. Never store the customer identity, entire credit or plan.
    return { request: {
      accion: "CONFIRMAR", valor: request.valor, metodoPago: request.metodoPago,
      observacion: request.observacion, quoteHash: request.quoteHash, idempotencyKey: request.idempotencyKey,
      ...(request.conciliacion ? { conciliacion: request.conciliacion } : {}),
    }, error: "" };
  } catch {
    return { request: null, error: "No se pudo recuperar con seguridad la confirmación pendiente. Verifica el recaudo con administración antes de intentar otro abono; no borres los datos de esta sesión." };
  }
}

function persistPendingConfirmation(creditId: number, request: PrincipalConfirmationRequest) {
  const entry = JSON.stringify({ version: 1, creditId, request });
  window.sessionStorage.setItem(principalPendingStorageKey(creditId), entry);
  if (window.sessionStorage.getItem(principalPendingStorageKey(creditId)) !== entry) throw new Error("Pending confirmation was not persisted");
}

function clearPendingConfirmation(creditId: number) {
  try { window.sessionStorage.removeItem(principalPendingStorageKey(creditId)); }
  catch { /* A retained successful request is safe: the next explicit retry replays its receipt. */ }
}

type CapitalQuote = {
  saldoCapitalAntes: number;
  saldoCapitalDespues: number;
  abonoCapital: number;
  cuotaHabitual: number;
  ultimaCuota: { numero: number; fechaVencimiento: string; valor: number } | null;
  cuotasPendientesAntes: number;
  cuotasPendientesDespues: number;
  cuotasEliminadas: number;
  saldoPendienteAntes: number;
  saldoPendienteDespues: number;
  planCapitalVigente: {
    cuotas: Array<{
      numero: number;
      fechaVencimiento: string;
      valorProgramado: number;
      valorAbonadoAlCorte: number;
      eliminada?: boolean;
      capital?: number;
      interes?: number;
      fianza?: number;
      seguro?: number;
      saldoCapital?: number;
    }>;
  };
};

type CapitalResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  quote?: CapitalQuote;
  quoteHash?: string;
  item?: { id: number };
  abonoId?: number;
};

type CapitalContext = {
  requiereConciliacion: boolean;
  modoConciliacion: "AUTOMATICA" | "MANUAL" | "VIGENTE";
  motivoConciliacion: string | null;
  capitalPendiente: number | null;
};

function parseCapitalContext(value: unknown): CapitalContext {
  const result = value as Partial<CapitalContext> & { ok?: boolean } | null;
  if (!result?.ok || !["AUTOMATICA", "MANUAL", "VIGENTE"].includes(result.modoConciliacion || "") ||
      typeof result.requiereConciliacion !== "boolean" ||
      result.requiereConciliacion !== (result.modoConciliacion === "MANUAL") ||
      !(result.capitalPendiente === null || (typeof result.capitalPendiente === "number" && Number.isFinite(result.capitalPendiente) && result.capitalPendiente >= 0)) ||
      !(result.motivoConciliacion === null || typeof result.motivoConciliacion === "string")) {
    throw new Error("No se pudo verificar la información financiera del crédito. Reintenta la consulta antes de continuar.");
  }
  return result as CapitalContext;
}

export type PrincipalPaymentCredit = {
  id: number;
  cuotaHabitual: number;
  numeroProximaCuota: number | null;
  planCapitalVigente?: unknown;
  revisionKey: string;
};

type CapitalForm = {
  valor: string;
  capitalPendiente: string;
  tasaPeriodo: string;
  cuotaCredito: string;
  fianzaCuota: string;
  seguroCuota: string;
  fuente: string;
  metodoPago: string;
  observacion: string;
};

const EMPTY_FORM: CapitalForm = {
  valor: "", capitalPendiente: "", tasaPeriodo: "", cuotaCredito: "",
  fianzaCuota: "", seguroCuota: "", fuente: "", metodoPago: "EFECTIVO", observacion: "",
};

function money(value: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

function date(value: string) {
  const day = value.slice(0, 10).split("-");
  return day.length === 3 ? `${day[2]}/${day[1]}/${day[0]}` : value;
}

export function buildPrincipalPaymentPayload(
  form: CapitalForm,
  credit: PrincipalPaymentCredit,
  sourceConfirmed: boolean,
  ordinaryPaymentsConfirmed: boolean,
  requiereConciliacion = !credit.planCapitalVigente,
): PrincipalPaymentPayload {
  const valor = Number(form.valor);
  if (!Number.isSafeInteger(valor) || valor <= 0) throw new Error("Indica un abono a capital válido en pesos enteros.");
  if (!ordinaryPaymentsConfirmed) throw new Error("Confirma que ya registraste los pagos ordinarios correspondientes.");
  const payload: PrincipalPaymentPayload = { valor, metodoPago: form.metodoPago, observacion: form.observacion.trim() };
  if (!requiereConciliacion) return payload;
  if (!sourceConfirmed || form.fuente.trim().length < 10) {
    throw new Error("Documenta la fuente de conciliación y confirma sus valores antes de continuar.");
  }
  if (!credit.numeroProximaCuota) throw new Error("No se encontró una próxima cuota pendiente. Actualiza los recaudos.");
  const fields = ["capitalPendiente", "cuotaCredito", "fianzaCuota", "seguroCuota"] as const;
  for (const field of fields) {
    if (!form[field].trim() || !Number.isSafeInteger(Number(form[field])) || Number(form[field]) < 0) {
      throw new Error("Completa capital, cuota de crédito, aval y seguro con los valores documentados en pesos enteros.");
    }
  }
  const tasaPeriodo = Number(form.tasaPeriodo.replace(",", "."));
  if (!form.tasaPeriodo.trim() || !Number.isFinite(tasaPeriodo) || tasaPeriodo < 0 || tasaPeriodo >= 1) {
    throw new Error("Indica la tasa periódica en decimal, no la tasa anual ni un porcentaje.");
  }
  const cuotaCredito = Number(form.cuotaCredito);
  const fianzaCuota = Number(form.fianzaCuota);
  const seguroCuota = Number(form.seguroCuota);
  if (Number(form.capitalPendiente) <= valor) throw new Error("El abono parcial debe ser menor al capital pendiente. Para pagar todo, solicita una liquidación conciliada con administración.");
  if (Math.abs(cuotaCredito + fianzaCuota + seguroCuota - credit.cuotaHabitual) > 0.01) {
    throw new Error("Capital e interés de la cuota, aval y seguro deben sumar la cuota habitual del crédito.");
  }
  payload.conciliacion = {
    capitalPendiente: Number(form.capitalPendiente), tasaPeriodo, cuotaCredito, fianzaCuota, seguroCuota,
    numeroProximaCuota: credit.numeroProximaCuota, fuente: form.fuente.trim(),
  };
  return payload;
}

export default function CreditPrincipalPaymentPanel({
  credit, disabled = false, onApplied, onBusyChange, initiallyExpanded = false,
}: {
  credit: PrincipalPaymentCredit;
  disabled?: boolean;
  initiallyExpanded?: boolean;
  onApplied: () => void | Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [recovery] = useState(() => recoverPendingConfirmation(credit.id));
  const [expanded, setExpanded] = useState(Boolean(initiallyExpanded || recovery.request || recovery.error));
  const [form, setForm] = useState<CapitalForm>(() => recovery.request ? {
    ...EMPTY_FORM, valor: String(recovery.request.valor), metodoPago: recovery.request.metodoPago,
    observacion: recovery.request.observacion,
  } : EMPTY_FORM);
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [ordinaryConfirmedAt, setOrdinaryConfirmedAt] = useState<string | null>(null);
  const ordinaryConfirmed = ordinaryConfirmedAt === credit.revisionKey;
  const [preview, setPreview] = useState<{ quote: CapitalQuote; hash: string; fingerprint: string; payload: PrincipalPaymentPayload } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [error, setError] = useState(recovery.error);
  const [success, setSuccess] = useState("");
  const [retryPending, setRetryPending] = useState(Boolean(recovery.request));
  const [context, setContext] = useState<{ key: string; data: CapitalContext } | null>(null);
  const [contextFailure, setContextFailure] = useState<{ key: string; message: string } | null>(null);
  const [contextAttempt, setContextAttempt] = useState(0);
  const requestLock = useRef(false);
  const mounted = useRef(true);
  const previewController = useRef<AbortController | null>(null);
  const submittedRequest = useRef<PrincipalConfirmationRequest | null>(recovery.request);
  const contextKey = JSON.stringify([credit.id, credit.revisionKey, Boolean(credit.planCapitalVigente)]);
  const currentContextKey = useRef(contextKey);
  currentContextKey.current = contextKey;
  const currentContext = context?.key === contextKey ? context.data : null;
  const currentContextError = contextFailure?.key === contextKey ? contextFailure.message : "";
  const needsContext = !credit.planCapitalVigente && !retryPending && !recovery.error && !success;
  const contextReady = Boolean(credit.planCapitalVigente) || Boolean(currentContext);
  const requiresManual = !credit.planCapitalVigente && currentContext?.requiereConciliacion === true;
  const fingerprint = JSON.stringify([credit.id, credit.revisionKey, form, sourceConfirmed, ordinaryConfirmed, currentContext, contextAttempt]);
  const currentFingerprint = useRef(fingerprint);
  currentFingerprint.current = fingerprint;
  const currentPreview = preview?.fingerprint === fingerprint ? preview : null;
  const locked = disabled || busy || retryPending || Boolean(success) || Boolean(recovery.error);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; previewController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!expanded || !needsContext) return;
    const controller = new AbortController();
    let active = true;
    const requestedKey = contextKey;
    setContext(null); setContextFailure(null); setPreview(null); setConfirmationOpen(false); setSourceConfirmed(false);
    void (async () => {
      try {
        const response = await fetch(`/api/creditos/${credit.id}/abono-capital`, {
          method: "GET", cache: "no-store", signal: controller.signal,
        });
        const result = await response.json();
        if (!active || !mounted.current || controller.signal.aborted || currentContextKey.current !== requestedKey) return;
        if (!response.ok) throw new Error(result?.error || "No fue posible consultar los datos del crédito.");
        setContext({ key: requestedKey, data: parseCapitalContext(result) });
      } catch (failure) {
        if (!active || !mounted.current || controller.signal.aborted || currentContextKey.current !== requestedKey) return;
        setContextFailure({ key: requestedKey, message: failure instanceof Error ? failure.message : "No fue posible consultar los datos del crédito." });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [expanded, needsContext, contextKey, credit.id, contextAttempt]);

  useEffect(() => {
    onBusyChange(busy || retryPending || Boolean(recovery.error));
    return () => onBusyChange(false);
  }, [busy, retryPending, recovery.error, onBusyChange]);

  useEffect(() => {
    if (!retryPending && !(busy && submittedRequest.current)) return;
    const warning = "Hay un abono a capital pendiente de confirmar. Si sales, vuelve a este crédito y verifica la misma operación antes de registrar otro abono.";
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const beforeNavigation = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("a[href]") || window.confirm(warning)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeNavigation, true);
    };
  }, [busy, retryPending]);

  function update(field: keyof CapitalForm, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
    if (!["valor", "metodoPago", "observacion"].includes(field)) setSourceConfirmed(false);
    setPreview(null);
    setError("");
  }

  async function previewPayment() {
    if (requestLock.current || disabled || retryPending || success || recovery.error || !contextReady || currentContextError) return;
    let payload: PrincipalPaymentPayload;
    try { payload = buildPrincipalPaymentPayload(form, credit, sourceConfirmed, ordinaryConfirmed, requiresManual); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Revisa los datos del abono."); return; }
    requestLock.current = true;
    setBusy(true); setError(""); setPreview(null);
    const requestFingerprint = fingerprint;
    const controller = new AbortController();
    previewController.current?.abort(); previewController.current = controller;
    try {
      const response = await fetch(`/api/creditos/${credit.id}/abono-capital`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ accion: "PREVISUALIZAR", ...payload }),
      });
      const result = await response.json() as CapitalResponse;
      if (!mounted.current || currentFingerprint.current !== requestFingerprint) return;
      if (!response.ok || !result.ok || !result.quote || !result.quoteHash) {
        throw new Error(result.error || result.message || "No fue posible previsualizar el abono.");
      }
      submittedRequest.current = null;
      setPreview({ quote: result.quote, hash: result.quoteHash, payload, fingerprint: requestFingerprint });
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && currentFingerprint.current === requestFingerprint) setError(failure instanceof Error ? failure.message : "No fue posible consultar el nuevo plan.");
    } finally {
      requestLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function confirmPayment() {
    if (requestLock.current || (disabled && !submittedRequest.current) || success || recovery.error || (!currentPreview && !submittedRequest.current)) return;
    requestLock.current = true;
    setBusy(true); setError("");
    try {
      if (!submittedRequest.current && currentPreview) {
        const request: PrincipalConfirmationRequest = {
          ...currentPreview.payload, accion: "CONFIRMAR", quoteHash: currentPreview.hash,
          idempotencyKey: crypto.randomUUID(),
        };
        try { persistPendingConfirmation(credit.id, request); }
        catch { throw new Error("No se pudo guardar la protección contra duplicados en esta sesión. El abono no fue enviado. Habilita el almacenamiento de sesión y vuelve a confirmar."); }
        submittedRequest.current = request;
      }
      const response = await fetch(`/api/creditos/${credit.id}/abono-capital`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submittedRequest.current),
      });
      const result = await response.json() as CapitalResponse;
      if (!mounted.current) return;
      if (!response.ok || !result.ok) {
        const idempotencyConflict = response.status === 409 && /clave|otros datos/i.test(result.error || "");
        if ((response.status === 400 || response.status === 409) && !idempotencyConflict) {
          clearPendingConfirmation(credit.id);
          submittedRequest.current = null; setRetryPending(false); setPreview(null); setConfirmationOpen(false);
          throw new Error(response.status === 409
            ? `${result.error || "El crédito cambió."} Actualiza los recaudos y genera una nueva previsualización.`
            : result.error || result.message || "El abono no pudo registrarse. Revisa los datos y previsualiza nuevamente.");
        }
        throw new Error(result.error || "No se pudo confirmar la respuesta del servidor.");
      }
      clearPendingConfirmation(credit.id);
      submittedRequest.current = null; setRetryPending(false); setConfirmationOpen(false); setPreview(null);
      setSuccess("Abono a capital registrado. El plan de pagos fue actualizado con reducción de plazo.");
      try { await onApplied(); }
      catch { if (mounted.current) setError("El pago quedó registrado, pero no se pudo refrescar la pantalla. Actualiza los recaudos; no registres nuevamente el abono."); }
    } catch (failure) {
      if (!mounted.current) return;
      if (submittedRequest.current) { setRetryPending(true); setConfirmationOpen(false); }
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar la respuesta del servidor.");
    } finally {
      requestLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function amountField(field: "valor" | "capitalPendiente" | "cuotaCredito" | "fianzaCuota" | "seguroCuota", label: string) {
    return <label className="grid gap-2 text-sm font-semibold" key={field}>
      {label}
      <Input inputMode="numeric" value={form[field] ? new Intl.NumberFormat("es-CO").format(Number(form[field])) : ""}
        onChange={(event) => update(field, event.target.value.replace(/\D/g, ""))} disabled={locked} />
    </label>;
  }

  return <Card className="p-5 text-[var(--fp-graphite)]">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h3 className="text-lg font-bold">Abono extraordinario a capital</h3>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">Mantiene la cuota habitual y reduce el plazo. No es un adelanto de cuotas.</p>
      </div>
      <Button variant="secondary" disabled={busy || retryPending} aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}>{expanded ? "Ocultar abono a capital" : "Preparar abono a capital"}</Button>
    </div>
    {expanded && <div className="mt-5 space-y-5">
      <p className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-amber-soft)] p-4 text-sm">
        Registra primero las cuotas ordinarias que el cliente pagará. Aquí ingresa únicamente el dinero adicional destinado a capital. Este proceso no calcula ni agrega mora.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {amountField("valor", "Valor adicional a capital (COP)")}
        <label className="grid gap-2 text-sm font-semibold">Método de pago
          <Select value={form.metodoPago} disabled={locked} onChange={(event) => update("metodoPago", event.target.value)}>
            {PAYMENT_METHOD_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </label>
        <label className="grid gap-2 text-sm font-semibold">Próxima cuota pendiente
          <Input value={credit.numeroProximaCuota ?? "Sin cuotas pendientes"} readOnly aria-readonly="true" />
        </label>
      </div>
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--fp-graphite)]" disabled={locked}
          checked={ordinaryConfirmed} onChange={(event) => { setOrdinaryConfirmedAt(event.target.checked ? credit.revisionKey : null); setPreview(null); }} />
        Ya registré los pagos ordinarios correspondientes y el saldo consultado está actualizado.
      </label>
      {needsContext && !contextReady && !currentContextError && <p role="status" className="text-sm text-[var(--fp-muted)]">Verificando los datos financieros del crédito antes de previsualizar…</p>}
      {needsContext && currentContextError && <div className="space-y-3">
        <p role="alert" className="text-sm font-semibold text-[var(--fp-danger)]">{currentContextError}</p>
        <Button variant="secondary" disabled={locked} onClick={() => { setContext(null); setContextFailure(null); setPreview(null); setContextAttempt((attempt) => attempt + 1); }}>Reintentar consulta del crédito</Button>
      </div>}
      {requiresManual && !retryPending && <fieldset className="space-y-4 border-t border-[var(--fp-border)] pt-4" disabled={locked}>
        <legend className="px-1 text-base font-bold">Conciliación documentada del capital</legend>
        {currentContext?.motivoConciliacion && <p className="text-sm text-[var(--fp-muted)]">{currentContext.motivoConciliacion}</p>}
        <p className="text-sm text-[var(--fp-muted)]">Para el primer abono, verifica estos datos contra el estado de cuenta o plan vigente. No uses el saldo total de cuotas como capital ni una tasa vigente diferente a la pactada.</p>
        <div className="grid gap-4 md:grid-cols-3">
          {amountField("capitalPendiente", "Capital después de pagar las cuotas (COP)")}
          {amountField("cuotaCredito", "Cuota de capital + interés (COP)")}
          {amountField("fianzaCuota", "Aval / fianza por cuota (COP)")}
          {amountField("seguroCuota", "Seguro por cuota (COP)")}
          <label className="grid gap-2 text-sm font-semibold">Tasa periódica (decimal)
            <Input inputMode="decimal" value={form.tasaPeriodo} onChange={(event) => update("tasaPeriodo", event.target.value)} disabled={locked} />
            <span className="text-xs font-normal text-[var(--fp-muted)]">Ejemplo de formato: 1 % por período se escribe 0,01. No ingreses la tasa anual.</span>
          </label>
          <div className="text-sm"><p className="font-semibold">Cuota habitual registrada</p><p className="mt-3 text-xl font-bold">{money(credit.cuotaHabitual)}</p></div>
        </div>
        <label className="grid gap-2 text-sm font-semibold">Fuente de conciliación
          <Input value={form.fuente} onChange={(event) => update("fuente", event.target.value)} maxLength={1000}
            placeholder="Documento o reporte, fecha de corte y referencia verificable" disabled={locked} />
        </label>
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--fp-graphite)]" checked={sourceConfirmed} disabled={locked}
            onChange={(event) => { setSourceConfirmed(event.target.checked); setPreview(null); }} />
          Verifiqué el capital, la tasa y los componentes de la cuota en la fuente indicada. Esta conciliación quedará auditada.
        </label>
      </fieldset>}
      {!retryPending && currentContext?.modoConciliacion === "AUTOMATICA" && <div className="space-y-2">
        <Badge tone="positive">Datos financieros automáticos</Badge>
        <p className="text-sm text-[var(--fp-muted)]">Se utilizan la amortización original registrada en FINSERPAY y los pagos aplicados. No necesitas ingresar manualmente el capital, la tasa ni los componentes de la cuota.</p>
        {currentContext.capitalPendiente !== null && <p className="text-sm">Capital pendiente: <strong>{money(currentContext.capitalPendiente)}</strong></p>}
      </div>}
      {!retryPending && (Boolean(credit.planCapitalVigente) || currentContext?.modoConciliacion === "VIGENTE") && <Badge tone="positive">Se utiliza el capital y el plan vigente del abono anterior</Badge>}
      <label className="grid gap-2 text-sm font-semibold">Observación (opcional)
        <Input value={form.observacion} maxLength={500} disabled={locked} onChange={(event) => update("observacion", event.target.value)} />
      </label>
      {error && <p role="alert" className="text-sm font-semibold text-[var(--fp-danger)]">{error}</p>}
      {success && <p role="status" className="text-sm font-semibold">{success}</p>}
      {retryPending ? <div className="space-y-3">
        <p className="text-sm">Existe una confirmación pendiente por {money(submittedRequest.current?.valor || 0)}. No registres otro abono ni cambies sus datos; recuperamos la misma operación de esta sesión para evitar duplicados. Nada se enviará hasta que pulses verificar.</p>
        <Button onClick={() => void confirmPayment()} disabled={busy}>{busy ? "Confirmando resultado..." : "Verificar resultado / reintentar misma operación"}</Button>
      </div> : !success && <Button variant={currentPreview ? "secondary" : "primary"} disabled={locked || !ordinaryConfirmed || !contextReady || Boolean(currentContextError)}
        onClick={() => void previewPayment()}>{busy ? "Consultando..." : "Previsualizar nuevo plan"}</Button>}
      {currentPreview && !retryPending && !success && <div className="space-y-4 border-t border-[var(--fp-border)] pt-5">
        <h4 className="text-base font-bold">Resultado antes de registrar el pago</h4>
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt>Capital anterior</dt><dd className="mt-1 text-lg font-bold">{money(currentPreview.quote.saldoCapitalAntes)}</dd></div>
          <div><dt>Capital después del abono</dt><dd className="mt-1 text-lg font-bold">{money(currentPreview.quote.saldoCapitalDespues)}</dd></div>
          <div><dt>Cuota habitual</dt><dd className="mt-1 text-lg font-bold">{money(currentPreview.quote.cuotaHabitual)}</dd></div>
          <div><dt>Cuotas eliminadas</dt><dd className="mt-1 text-lg font-bold">{currentPreview.quote.cuotasEliminadas}</dd></div>
        </dl>
        <p className="text-sm">Quedan {currentPreview.quote.cuotasPendientesDespues} cuotas de las {currentPreview.quote.cuotasPendientesAntes} pendientes.
          {currentPreview.quote.ultimaCuota && ` Última: cuota ${currentPreview.quote.ultimaCuota.numero}, ${date(currentPreview.quote.ultimaCuota.fechaVencimiento)}, por ${money(currentPreview.quote.ultimaCuota.valor)}.`}</p>
        <DataTable><table className="w-full min-w-[1100px] text-right text-sm">
          <caption className="p-3 text-left text-sm text-[var(--fp-muted)]">Plan actualizado: revisa los valores antes de confirmar. Las cuotas eliminadas quedan en cero.</caption>
          <thead><tr className="border-b border-[var(--fp-border)]">
            {["Cuota", "Vencimiento", "Capital", "Interés", "Aval", "Seguro", "Total", "Pagado al corte", "Saldo cuota", "Saldo capital"].map((title) => <th key={title} scope="col" className="p-3">{title}</th>)}
          </tr></thead>
          <tbody>{currentPreview.quote.planCapitalVigente.cuotas.map((row) => <tr key={row.numero} className="border-b border-[var(--fp-border)]">
            <th scope="row" className="p-3">{row.numero}{row.eliminada ? " · eliminada" : ""}</th>
            <td className="p-3 whitespace-nowrap">{date(row.fechaVencimiento)}</td>
            <td className="p-3">{row.capital == null ? "—" : money(row.capital)}</td>
            <td className="p-3">{row.interes == null ? "—" : money(row.interes)}</td>
            <td className="p-3">{row.fianza == null ? "—" : money(row.fianza)}</td>
            <td className="p-3">{row.seguro == null ? "—" : money(row.seguro)}</td>
            <td className="p-3 font-semibold">{money(row.valorProgramado)}</td>
            <td className="p-3">{money(row.valorAbonadoAlCorte || 0)}</td>
            <td className="p-3 font-semibold">{money(Math.max(0, row.valorProgramado - (row.valorAbonadoAlCorte || 0)))}</td>
            <td className="p-3">{row.saldoCapital == null ? "—" : money(row.saldoCapital)}</td>
          </tr>)}</tbody>
        </table></DataTable>
        <Button disabled={busy || disabled} onClick={() => setConfirmationOpen(true)}>Registrar {money(currentPreview.quote.abonoCapital)} a capital</Button>
      </div>}
      <ConfirmDialog open={confirmationOpen && Boolean(currentPreview)} title="Confirmar abono extraordinario a capital"
        description={currentPreview ? `Se registrarán ${money(currentPreview.quote.abonoCapital)} a capital. El saldo de capital quedará en ${money(currentPreview.quote.saldoCapitalDespues)} y se eliminarán ${currentPreview.quote.cuotasEliminadas} cuotas. Conserva el historial y modifica el plan futuro; verifica que coincide con la fuente conciliada.` : ""}
        confirmLabel="Confirmar abono a capital" busy={busy} onCancel={() => { if (!busy) setConfirmationOpen(false); }} onConfirm={() => void confirmPayment()} />
    </div>}
  </Card>;
}
