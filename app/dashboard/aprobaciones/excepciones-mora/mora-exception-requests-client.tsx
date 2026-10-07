"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, PageHeader, Select } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { colombiaDateKey } from "@/lib/colombia-date";
import type { MoraExceptionCreditSummary, MoraExceptionEligibility, MoraExceptionEvent, MoraExceptionRequestItem, MoraExceptionStatus, MoraExceptionType } from "@/lib/mora-exception-types";
import MoraSupports from "../mora-supports";

const states: Record<MoraExceptionStatus, string> = { PENDING: "Pendiente", APPROVED: "Aprobada", REJECTED: "Rechazada", EXPIRED: "Vencida", REPLACED: "Reemplazada" };
const actions: Record<MoraExceptionEvent["action"], string> = { SUBMITTED: "Enviada a revisión", APPROVED: "Aprobada", REJECTED: "Rechazada", EXPIRED: "Vencida", OBSERVED: "Observación registrada", REPLACED: "Reemplazada" };
const money = (value: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
function date(value: string | null, time = false) {
  if (!value) return "Sin registro";
  const parsed = new Date(value.length === 10 ? value + "T12:00:00-05:00" : value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", ...(time ? { timeStyle: "short" as const } : {}), timeZone: "America/Bogota" }).format(parsed) : "Fecha no disponible";
}
function tone(status: MoraExceptionStatus) { return status === "APPROVED" ? "positive" : status === "REJECTED" || status === "EXPIRED" ? "danger" : status === "REPLACED" ? "neutral" : "warning"; }
function expiry(value: string | null) { return value ? date(value) : "Sin vencimiento"; }
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "No se pudo completar la solicitud.");
  return payload as T;
}
function eventReason(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;
  return [body.reason, body.observation, body.decisionReason, body.bypassReason].filter(value => typeof value === "string").join(" · ");
}
type List = { items: MoraExceptionRequestItem[]; hasMore?: boolean; nextCursor?: string | null; credit?: MoraExceptionCreditSummary; eligibility?: MoraExceptionEligibility };
type Detail = { item: MoraExceptionRequestItem; history: MoraExceptionEvent[] };

export default function MoraExceptionRequestsClient({ centralAdmin, initialCreditId = null, initialCreateOpen = false }: { centralAdmin: boolean; initialCreditId?: number | null; initialCreateOpen?: boolean }) {
  const [status, setStatus] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [list, setList] = useState<List | null>(null);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(Boolean(initialCreditId) || initialCreateOpen);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MoraExceptionCreditSummary[]>([]);
  const [creditId, setCreditId] = useState<number | null>(initialCreditId);
  const [preflight, setPreflight] = useState<List | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [kind, setKind] = useState<MoraExceptionType>("EXCEPCION");
  const [expiresOn, setExpiresOn] = useState("");
  const [noExpiry, setNoExpiry] = useState(centralAdmin);
  const [promiseDate, setPromiseDate] = useState("");
  const [promiseAmount, setPromiseAmount] = useState("");
  const [reason, setReason] = useState("");
  const [observation, setObservation] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [confirm, setConfirm] = useState<"APPROVE" | "REJECT" | null>(null);
  const createKey = useRef<string | null>(null);
  const changeKey = useRef<string | null>(null);
  const today = colombiaDateKey(new Date());
  useEffect(() => { createKey.current = null; }, [creditId, kind, expiresOn, noExpiry, promiseDate, promiseAmount, reason, observation]);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "25" });
    if (status) params.set("status", status);
    if (typeFilter) params.set("type", typeFilter);
    if (cursor) params.set("cursor", cursor);
    request<List>("/api/aprobaciones/excepciones-mora?" + params, { signal: controller.signal })
      .then(setList).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [status, typeFilter, cursor, reload]);
  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController(); setDetailLoading(true); setDetail(null); setDecisionReason(""); changeKey.current = null;
    request<Detail>("/api/aprobaciones/excepciones-mora/" + detailId, { signal: controller.signal })
      .then(setDetail).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [detailId, reload]);
  useEffect(() => {
    if (!creditId) return;
    const controller = new AbortController(); setPreflightLoading(true); setPreflight(null);
    createKey.current = null;
    request<List>("/api/aprobaciones/excepciones-mora?creditoId=" + creditId, { signal: controller.signal })
      .then(data => { setPreflight(data); setPromiseAmount(String(data.eligibility?.promise.amount || "")); setPromiseDate(data.eligibility?.promise.date || ""); setExpiresOn(data.eligibility?.promise.date || ""); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setPreflightLoading(false); });
    return () => controller.abort();
  }, [creditId, reload]);
  const loadCandidate = useCallback(async (event: FormEvent) => {
    event.preventDefault(); if (query.trim().length < 2 || searching) return;
    setSearching(true); setError("");
    try { const endpoint = centralAdmin ? "/api/aprobaciones/excepciones-mora/creditos?q=" : "/api/aprobaciones/cartera-mora?q="; const data = await request<{ items: MoraExceptionCreditSummary[] }>(endpoint + encodeURIComponent(query.trim())); setCandidates(data.items); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo buscar el crédito."); }
    finally { setSearching(false); }
  }, [centralAdmin, query, searching]);
  const eligibility = preflight?.eligibility;
  const selectedCreditLoaded = Boolean(preflight?.credit && preflight.credit.id === creditId);
  const allowed = selectedCreditLoaded && (centralAdmin || (kind === "PRORROGA" ? eligibility?.prorroga.canRequest : eligibility?.excepcion.canRequest));
  const blockedReason = kind === "PRORROGA" ? eligibility?.prorroga.blockedReason : eligibility?.excepcion.blockedReason;
  const maxDate = !centralAdmin && kind === "PRORROGA" ? eligibility?.maxExpiresOn || undefined : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving || !creditId || !allowed) return;
    setSaving(true); setError(""); setNotice(""); createKey.current ??= crypto.randomUUID();
    try {
      const payload = centralAdmin ? {
        creditoId: creditId, type: kind, expiresOn: noExpiry ? null : expiresOn,
        reason, idempotencyKey: createKey.current,
      } : {
        creditoId: creditId, type: kind, expiresOn, promiseAmount: Number(promiseAmount), promiseDate, reason, observation,
        idempotencyKey: createKey.current,
      };
      const data = await request<{ item: MoraExceptionRequestItem; moraSync?: { ok: boolean; message: string } }>("/api/aprobaciones/excepciones-mora", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      createKey.current = null; setCreateOpen(false); setDetailId(data.item.id); setReload(value => value + 1); setNotice(centralAdmin ? "Excepción guardada y autorizada. El usuario, la fecha y el cambio quedaron registrados en el historial." : "Solicitud enviada a revisión. Puedes adjuntar sus soportes en el detalle.");
      if (data.moraSync && !data.moraSync.ok) setError(data.moraSync.message);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo enviar la solicitud."); }
    finally { setSaving(false); }
  }
  async function change(action: "APPROVE" | "REJECT" | "OBSERVE") {
    if (!detail || saving) return;
    setSaving(true); setError(""); setNotice(""); changeKey.current ??= crypto.randomUUID();
    try {
      const response = await request<{ moraSync?: { ok: boolean; message: string } }>("/api/aprobaciones/excepciones-mora/" + detail.item.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, version: detail.item.version, reason: decisionReason.trim() || (action === "APPROVE" ? "Aprobada por administrador central" : "Rechazada por administrador central"), idempotencyKey: changeKey.current }) });
      changeKey.current = null; setConfirm(null); setReload(value => value + 1); setNotice(action === "OBSERVE" ? "Observación guardada en el historial." : "Decisión guardada en el historial.");
      if (response.moraSync && !response.moraSync.ok) setError(response.moraSync.message);
    } catch (e) { setConfirm(null); setError(e instanceof Error ? e.message : "No se pudo registrar la gestión."); }
    finally { setSaving(false); }
  }
  return <main className="space-y-5 bg-[var(--fp-surface)] p-4 text-[var(--fp-graphite)] sm:p-6">
    <PageHeader title="Excepciones de mora" description={centralAdmin ? "Autoriza excepciones y prórrogas directamente. Cada cambio conserva su usuario y fecha en el historial." : "Gestiona solicitudes, prórrogas y soportes. Cada decisión conserva su responsable y motivo."} actions={<Button onClick={() => { setCreateOpen(true); setDetailId(null); }}><Plus className="h-4 w-4" aria-hidden="true" /> {centralAdmin ? "Nueva excepción" : "Nueva solicitud"}</Button>} />
    {error && <p role="alert" className="rounded-lg bg-[var(--fp-danger-soft)] p-3 text-sm text-[var(--fp-danger)]">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-[var(--fp-lime-soft)] p-3 text-sm">{notice}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Select aria-label="Filtrar estado" value={status} onChange={e => { setStatus(e.target.value); setCursor(""); }} className="!w-auto"><option value="">Todos los estados</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
      <Select aria-label="Filtrar tipo" value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setCursor(""); }} className="!w-auto"><option value="">Todos los tipos</option><option value="EXCEPCION">Excepción</option><option value="PRORROGA">Prórroga</option></Select>
      <Button variant="secondary" onClick={() => setReload(value => value + 1)} disabled={loading}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Actualizar</Button>
      <Link href="/dashboard/aprobaciones/cartera-mora" className="text-sm font-semibold underline underline-offset-4">Consultar cartera en mora</Link>
    </div>
    <div className={createOpen || detailId ? "grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" : "min-w-0"}>
      <Card className="min-w-0 overflow-hidden">
        {loading ? <LoadingState label="Cargando solicitudes de excepción…" /> : !list?.items.length ? <EmptyState title="Sin solicitudes" description="Las solicitudes enviadas y sus decisiones aparecerán aquí." /> : <DataTable><table className="w-full min-w-[700px] text-left text-sm"><thead><tr><th>Crédito / Cliente</th><th>Tipo</th><th>Estado</th><th>Vencimiento</th><th>Responsable</th><th><span className="sr-only">Detalle</span></th></tr></thead><tbody>{list.items.map(item => <tr key={item.id} className={detailId === item.id ? "bg-[var(--fp-lime-soft)]" : ""}>
          <td><strong>{item.credit?.folio || "Crédito " + item.creditoId}</strong><div>{item.credit?.clienteNombre || ""}</div><small>{item.credit?.clienteDocumento || ""}</small></td><td>{item.type === "PRORROGA" ? "Prórroga" : "Excepción"}</td><td><Badge tone={tone(item.status)}>{states[item.status]}</Badge></td><td>{expiry(item.expiresOn)}</td><td>{item.decidedByName || item.createdByName}</td><td><Button variant="secondary" onClick={() => { setDetailId(item.id); setCreateOpen(false); }}>Ver detalle</Button></td>
        </tr>)}</tbody></table></DataTable>}
        <div className="flex justify-between gap-3 border-t border-[var(--fp-border)] p-3"><Button variant="ghost" disabled={!cursor} onClick={() => setCursor("")}>Inicio</Button><Button variant="secondary" disabled={!list?.nextCursor || loading} onClick={() => setCursor(list?.nextCursor || "")}>Siguiente</Button></div>
      </Card>
      {createOpen && <Card className="space-y-4 p-4">
        <div className="flex items-center justify-between"><h2 className="font-bold">{centralAdmin ? "Nueva excepción" : "Nueva solicitud"}</h2><Button variant="ghost" aria-label="Cerrar formulario" onClick={() => setCreateOpen(false)} disabled={saving}><X className="h-4 w-4" /></Button></div>
        <form onSubmit={loadCandidate} className="flex gap-2"><Input aria-label={centralAdmin ? "Buscar crédito" : "Buscar crédito en mora"} placeholder="Cédula, crédito o IMEI" value={query} onChange={e => setQuery(e.target.value)} maxLength={100} /><Button type="submit" variant="secondary" disabled={searching || saving || query.trim().length < 2} aria-label="Buscar"><Search className="h-4 w-4" /></Button></form>
        {searching ? <LoadingState label="Buscando créditos…" /> : candidates.length > 0 ? <div className="max-h-48 overflow-y-auto divide-y divide-[var(--fp-border)]">{candidates.map(item => <button key={item.id} onClick={() => setCreditId(item.id)} disabled={saving} className="w-full px-1 py-3 text-left text-sm hover:bg-[var(--fp-lime-soft)] disabled:opacity-60"><strong>{item.clienteNombre}</strong><div>{item.clienteDocumento} · {item.numeroCreditoVisible}</div></button>)}</div> : query && <p className="text-sm text-[var(--fp-muted)]">{centralAdmin ? "Consulta un crédito para seleccionarlo." : "Consulta un crédito en mora para seleccionarlo."}</p>}
        {preflightLoading ? <LoadingState label={centralAdmin ? "Cargando crédito…" : "Verificando cuota y reglas…"} /> : preflight?.credit && selectedCreditLoaded && <>
          <div className="border-y border-[var(--fp-border)] py-3 text-sm"><strong>{preflight.credit.clienteNombre}</strong><p>{preflight.credit.clienteDocumento} · {preflight.credit.numeroCreditoVisible}</p><p>{preflight.credit.aliadoNombre} · {preflight.credit.equipo}</p><p className="mt-2">Vencido: <strong>{money(preflight.credit.valorVencido)}</strong> · {preflight.credit.diasMora} días de mora</p></div>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm font-semibold">Tipo<Select value={kind} onChange={e => { setKind(e.target.value as MoraExceptionType); createKey.current = null; }} disabled={saving}><option value="EXCEPCION">Excepción de mora</option><option value="PRORROGA">Prórroga de pago</option></Select></label>
            {centralAdmin ? <>
              <label className="flex min-h-10 items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={noExpiry} onChange={e => setNoExpiry(e.target.checked)} disabled={saving} className="h-4 w-4 accent-[var(--fp-graphite)]" /> Sin vencimiento</label>
              {!noExpiry && <label className="block text-sm font-semibold">Vencimiento<Input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)} min={today} required disabled={saving} /></label>}
              <label className="block text-sm font-semibold">Nota (opcional)<textarea className="fp-ui-input min-h-24" placeholder="Agrega un motivo o una observación si lo necesitas" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} disabled={saving} /></label>
              <p className="text-sm text-[var(--fp-muted)]">Se autoriza al guardar. Si existe una excepción vigente, se reemplaza y ambas quedan en el historial.</p>
              <Button type="submit" disabled={saving || !allowed}>{saving ? "Guardando…" : "Guardar excepción"}</Button>
            </> : <>
              {eligibility?.regularInstallment && <p className="text-sm">Cuota {eligibility.regularInstallment.number} · Fecha regular {date(eligibility.regularInstallment.dueDate)}</p>}
              {kind === "PRORROGA" && <p className="rounded-lg bg-[var(--fp-lime-soft)] p-3 text-sm">Fecha máxima permitida: <strong>{date(eligibility?.maxExpiresOn || null)}</strong>. La prórroga se solicita después del 02 o 17 y admite máximo 4 días calendario.</p>}
              {blockedReason && <p className="rounded-lg bg-[var(--fp-amber-soft)] p-3 text-sm" role="status">{blockedReason}</p>}
              <label className="block text-sm font-semibold">Vencimiento<Input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)} min={today} max={maxDate} required disabled={saving} /></label>
              <label className="block text-sm font-semibold">Valor que se compromete a pagar<Input type="number" min="1" step="1" value={promiseAmount} onChange={e => setPromiseAmount(e.target.value)} required disabled={saving} /></label>
              <label className="block text-sm font-semibold">Fecha del compromiso<Input type="date" min={today} max={expiresOn || maxDate} value={promiseDate} onChange={e => setPromiseDate(e.target.value)} required disabled={saving} /></label>
              <label className="block text-sm font-semibold">Motivo<Input value={reason} onChange={e => { setReason(e.target.value); createKey.current = null; }} minLength={5} maxLength={500} required disabled={saving} /></label>
              <label className="block text-sm font-semibold">Observación<textarea className="fp-ui-input min-h-24" value={observation} onChange={e => { setObservation(e.target.value); createKey.current = null; }} minLength={5} maxLength={2000} required disabled={saving} /></label>
              <p className="text-sm text-[var(--fp-muted)]">Los soportes se adjuntan en el detalle después de enviar. La solicitud queda pendiente del responsable autorizado.</p>
              <Button type="submit" disabled={saving || !allowed}>{saving ? "Enviando…" : "Enviar a revisión"}</Button>
            </>}
          </form>
        </>}
      </Card>}
      {detailId && <Card className="space-y-4 p-4">
        <div className="flex items-center justify-between"><h2 className="font-bold">Detalle de la solicitud</h2><Button variant="ghost" aria-label="Cerrar detalle" onClick={() => setDetailId(null)} disabled={saving}><X className="h-4 w-4" /></Button></div>
        {detailLoading ? <LoadingState label="Cargando historial…" /> : detail && <>
          <Badge tone={tone(detail.item.status)}>{states[detail.item.status]}</Badge>
          <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-[var(--fp-muted)]">Crédito</dt><dd className="font-semibold">{detail.item.credit?.folio || detail.item.creditoId}</dd></div><div><dt className="text-[var(--fp-muted)]">Tipo</dt><dd>{detail.item.type === "PRORROGA" ? "Prórroga" : "Excepción"}</dd></div>{detail.item.installmentNumber !== null && <div><dt className="text-[var(--fp-muted)]">Cuota regular</dt><dd>{detail.item.installmentNumber} · {date(detail.item.installmentDueDate)}</dd></div>}<div><dt className="text-[var(--fp-muted)]">Vencimiento</dt><dd>{expiry(detail.item.expiresOn)}</dd></div>{!detail.item.centralDirect && detail.item.promiseAmount !== null && <><div><dt className="text-[var(--fp-muted)]">Compromiso</dt><dd>{money(detail.item.promiseAmount)} · {date(detail.item.promiseDate)}</dd></div><div><dt className="text-[var(--fp-muted)]">Pago recibido</dt><dd>{money(detail.item.paidTowardPromise)}</dd></div></>}</dl>
          <div className="text-sm"><strong>Motivo</strong><p className="whitespace-pre-wrap">{detail.item.reason}</p>{detail.item.observation && <><strong className="mt-3 block">Observación</strong><p className="whitespace-pre-wrap">{detail.item.observation}</p></>}</div>
          {detail.item.cooldownBypassed && <p className="rounded-lg bg-[var(--fp-amber-soft)] p-3 text-sm">Enfriamiento omitido por autorización: {detail.item.cooldownBypassReason}</p>}
          {detail.item.conditionStatus === "FULFILLED" && <Badge tone="positive">Compromiso cumplido</Badge>}
          {detail.item.conditionStatus === "BREACHED" && <Badge tone="danger">Compromiso incumplido</Badge>}
          <MoraSupports key={detail.item.id} creditoId={detail.item.creditoId} subjectKind="EXCEPCION" subjectId={detail.item.id} defaultOpen={!centralAdmin} />
          <label className="block text-sm font-semibold">{centralAdmin ? "Observación (opcional)" : "Observación o motivo de decisión"}<textarea className="fp-ui-input min-h-24" value={decisionReason} onChange={e => { setDecisionReason(e.target.value); changeKey.current = null; }} minLength={centralAdmin ? undefined : 5} maxLength={1000} disabled={saving} /></label>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={saving || decisionReason.trim().length < (centralAdmin ? 1 : 5)} onClick={() => void change("OBSERVE")}>Guardar observación</Button>{centralAdmin && detail.item.status === "PENDING" && <><Button disabled={saving} onClick={() => setConfirm("APPROVE")}>Aprobar</Button><Button variant="danger" disabled={saving} onClick={() => setConfirm("REJECT")}>Rechazar</Button></>}</div>
          {!centralAdmin && detail.item.status === "PENDING" && <p className="text-sm text-[var(--fp-muted)]">La decisión corresponde al administrador central autorizado.</p>}
          <section className="border-t border-[var(--fp-border)] pt-4"><h3 className="mb-3 font-bold">Historial de decisiones y responsables</h3><ol className="space-y-4">{detail.history.map(item => <li key={item.id} className="border-l-2 border-[var(--fp-border)] pl-3 text-sm"><strong>{actions[item.action]}</strong><p>{date(item.createdAt, true)} · {item.actorName}</p><p className="whitespace-pre-wrap text-[var(--fp-muted)]">{eventReason(item.payload)}</p></li>)}</ol></section>
        </>}
      </Card>}
    </div>
    <ConfirmDialog open={Boolean(confirm)} title={confirm === "APPROVE" ? "Aprobar solicitud" : "Rechazar solicitud"} description={decisionReason.trim() ? `Se registrará tu decisión y el motivo: ${decisionReason}` : "Se registrará la decisión del administrador central con tu usuario, fecha y hora."} confirmLabel={confirm === "APPROVE" ? "Confirmar aprobación" : "Confirmar rechazo"} danger={confirm === "REJECT"} busy={saving} onCancel={() => setConfirm(null)} onConfirm={() => confirm && void change(confirm)} />
  </main>;
}
