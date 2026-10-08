"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, Plus, RefreshCw, Search } from "lucide-react";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, Select, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import { colombiaDateKey } from "@/lib/colombia-date";
import type { MoraExceptionCreditSummary, MoraExceptionEligibility, MoraExceptionEvent, MoraExceptionRequestItem, MoraExceptionStatus, MoraExceptionType } from "@/lib/mora-exception-types";
import MoraSupports from "../mora-supports";
import styles from "./mora-exception-requests.module.css";

const states: Record<MoraExceptionStatus, string> = { PENDING: "Pendiente", APPROVED: "Aprobada", REJECTED: "Rechazada", EXPIRED: "Vencida", REPLACED: "Reemplazada" };
const actions: Record<MoraExceptionEvent["action"], string> = { SUBMITTED: "Enviada a revisión", APPROVED: "Aprobada", REJECTED: "Rechazada", EXPIRED: "Vencida", OBSERVED: "Observación registrada", REPLACED: "Reemplazada" };
const tabs = [{ value: "", label: "Todas" }, { value: "PENDING", label: "Pendientes" }, { value: "APPROVED", label: "Aprobadas" }, { value: "EXPIRED", label: "Vencidas" }];
const money = (value: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
const identifier = (value?: string | null) => value ? String(value).replace(/[.\s,]/g, "") : "Sin registro";
function date(value: string | null, time = false) {
  if (!value) return "Sin registro";
  const parsed = new Date(value.length === 10 ? value + "T12:00:00-05:00" : value);
  if (!Number.isFinite(parsed.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}), timeZone: "America/Bogota" }).format(parsed);
}
function tone(status: MoraExceptionStatus) { return status === "APPROVED" ? "positive" : status === "REJECTED" || status === "EXPIRED" ? "danger" : status === "REPLACED" ? "neutral" : "warning"; }
function expiry(value: string | null) { return value ? date(value) : "Sin vencimiento"; }
function CreditNumber({ number }: { number?: string | null }) {
  return number ? <strong className={styles.creditNumber}>Sadmin: {number}</strong> : <Badge tone="warning" className={styles.pendingSadmin}>PENDIENTE SADMIN</Badge>;
}
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
type List = { items: MoraExceptionRequestItem[]; total: number; page: number; pageSize: number; totalPages: number; credit?: MoraExceptionCreditSummary; eligibility?: MoraExceptionEligibility };
type Detail = { item: MoraExceptionRequestItem; history: MoraExceptionEvent[]; credit?: MoraExceptionCreditSummary; eligibility?: MoraExceptionEligibility };

export default function MoraExceptionRequestsClient({ centralAdmin, initialCreditId = null, initialCreateOpen = false }: { centralAdmin: boolean; initialCreditId?: number | null; initialCreateOpen?: boolean }) {
  const [status, setStatus] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [list, setList] = useState<List | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [createOpen, setCreateOpen] = useState(Boolean(initialCreditId) || initialCreateOpen);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MoraExceptionCreditSummary[]>([]);
  const [candidateSearched, setCandidateSearched] = useState(false);
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
  const submitting = useRef(false);
  const candidateController = useRef<AbortController | null>(null);
  const today = colombiaDateKey(new Date());
  useEffect(() => { createKey.current = null; }, [creditId, kind, expiresOn, noExpiry, promiseDate, promiseAmount, reason, observation]);
  useEffect(() => () => candidateController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setListError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) params.set("status", status);
    if (typeFilter) params.set("type", typeFilter);
    if (appliedSearch) params.set("q", appliedSearch);
    request<List>("/api/aprobaciones/excepciones-mora?" + params, { signal: controller.signal })
      .then(data => { if (controller.signal.aborted) return; setList(data); const lastPage = Math.max(1, data.totalPages); if (page > lastPage) setPage(lastPage); else if (data.page !== page) setPage(data.page); })
      .catch(e => { if (!controller.signal.aborted) setListError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [status, typeFilter, appliedSearch, page, pageSize, reload]);
  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController(); setDetailLoading(true); setDetail(null); setDetailError(""); setDecisionReason(""); changeKey.current = null;
    request<Detail>("/api/aprobaciones/excepciones-mora/" + detailId, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setDetail(data); })
      .catch(e => { if (!controller.signal.aborted) setDetailError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [detailId, reload]);
  useEffect(() => {
    if (!creditId || !createOpen) return;
    const controller = new AbortController(); setPreflightLoading(true); setPreflight(null); createKey.current = null;
    request<List>("/api/aprobaciones/excepciones-mora?creditoId=" + creditId, { signal: controller.signal })
      .then(data => { if (controller.signal.aborted) return; setPreflight(data); setPromiseAmount(String(data.eligibility?.promise.amount || "")); setPromiseDate(data.eligibility?.promise.date || ""); setExpiresOn(data.eligibility?.promise.date || ""); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setPreflightLoading(false); });
    return () => controller.abort();
  }, [creditId, createOpen, reload]);
  const loadCandidate = useCallback(async (event: FormEvent) => {
    event.preventDefault(); if (query.trim().length < 2 || searching) return;
    candidateController.current?.abort(); const controller = new AbortController(); candidateController.current = controller;
    setSearching(true); setError(""); setCandidateSearched(false);
    try {
      const endpoint = centralAdmin ? "/api/aprobaciones/excepciones-mora/creditos?q=" : "/api/aprobaciones/cartera-mora?q=";
      const data = await request<{ items: MoraExceptionCreditSummary[] }>(endpoint + encodeURIComponent(query.trim()), { signal: controller.signal });
      if (!controller.signal.aborted) { setCandidates(data.items); setCandidateSearched(true); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "No se pudo buscar el crédito."); }
    finally { if (!controller.signal.aborted) setSearching(false); }
  }, [centralAdmin, query, searching]);
  const eligibility = preflight?.eligibility;
  const selectedCreditLoaded = Boolean(preflight?.credit && preflight.credit.id === creditId);
  const allowed = selectedCreditLoaded && (centralAdmin || (kind === "PRORROGA" ? eligibility?.prorroga.canRequest : eligibility?.excepcion.canRequest));
  const blockedReason = kind === "PRORROGA" ? eligibility?.prorroga.blockedReason : eligibility?.excepcion.blockedReason;
  const maxDate = !centralAdmin && kind === "PRORROGA" ? eligibility?.maxExpiresOn || undefined : undefined;

  function filterStatus(value: string) { setStatus(value); setPage(1); }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); filterStatus(tabs[next].value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitting.current || !creditId || !allowed) return;
    submitting.current = true; setSaving(true); setError(""); setNotice(""); createKey.current ??= crypto.randomUUID();
    try {
      const payload = centralAdmin ? { creditoId: creditId, type: kind, expiresOn: noExpiry ? null : expiresOn, reason, idempotencyKey: createKey.current } :
        { creditoId: creditId, type: kind, expiresOn, promiseAmount: Number(promiseAmount), promiseDate, reason, observation, idempotencyKey: createKey.current };
      const data = await request<{ item: MoraExceptionRequestItem; moraSync?: { ok: boolean; message: string } }>("/api/aprobaciones/excepciones-mora", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      createKey.current = null; setCreateOpen(false); setDetailId(data.item.id); setReload(value => value + 1);
      setNotice(centralAdmin ? "Excepción guardada y autorizada. La gestión quedó registrada en el historial." : "Solicitud enviada a revisión. Puedes adjuntar sus soportes en el detalle.");
      if (data.moraSync && !data.moraSync.ok) setError(data.moraSync.message);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo enviar la solicitud."); }
    finally { submitting.current = false; setSaving(false); }
  }
  async function change(action: "APPROVE" | "REJECT" | "OBSERVE") {
    if (!detail || submitting.current) return;
    submitting.current = true; setSaving(true); setError(""); setNotice(""); changeKey.current ??= crypto.randomUUID();
    try {
      const response = await request<{ moraSync?: { ok: boolean; message: string } }>("/api/aprobaciones/excepciones-mora/" + detail.item.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, version: detail.item.version, reason: decisionReason.trim() || (action === "APPROVE" ? "Aprobada por administrador central" : "Rechazada por administrador central"), idempotencyKey: changeKey.current }) });
      changeKey.current = null; setConfirm(null); setReload(value => value + 1);
      setNotice(action === "OBSERVE" ? "Observación guardada en el historial." : "Decisión guardada en el historial.");
      if (response.moraSync && !response.moraSync.ok) setError(response.moraSync.message);
    } catch (e) { setConfirm(null); setError(e instanceof Error ? e.message : "No se pudo registrar la gestión."); }
    finally { submitting.current = false; setSaving(false); }
  }
  const currentPage = list?.page || page;
  const total = list?.total ?? 0;
  const totalPages = list?.totalPages || 1;
  const from = total ? (currentPage - 1) * (list?.pageSize || pageSize) + 1 : 0;
  const to = total ? from + (list?.items.length || 0) - 1 : 0;
  const detailCredit = detail?.credit || detail?.item.credit;

  return <main className={styles.main}>
    <header className={styles.heading}>
      <div><h1>Excepciones de mora</h1><p>Consulta y gestiona las solicitudes.</p></div>
      <Button className={styles.newRequest} onClick={() => { setCreateOpen(true); setDetailId(null); setError(""); }}><Plus size={18} aria-hidden="true" /> Nueva solicitud</Button>
    </header>
    {error && !createOpen && !detailId && <p role="alert" className={styles.error}>{error}</p>}
    {notice && !detailId && <p role="status" className={styles.notice}>{notice}</p>}
    <Card className={styles.listing}>
      <div className={styles.tabsRow}>
        <div className={styles.tabs} role="tablist" aria-label="Estados de solicitudes">
          {tabs.map((tab, index) => <button key={tab.value} type="button" role="tab" aria-selected={status === tab.value} aria-controls="mora-results" tabIndex={status === tab.value || (!tabs.some(item => item.value === status) && index === 0) ? 0 : -1} className={status === tab.value ? styles.activeTab : ""} onClick={() => filterStatus(tab.value)} onKeyDown={event => tabKey(event, index)}>{tab.label}</button>)}
        </div>
        <Select aria-label="Otros estados" className={styles.otherStates} value={status === "REJECTED" || status === "REPLACED" ? status : ""} onChange={event => { if (event.target.value) filterStatus(event.target.value); }}>
          <option value="">Otros estados</option><option value="REJECTED">Rechazadas</option><option value="REPLACED">Reemplazadas</option>
        </Select>
      </div>
      <div className={styles.toolbar}>
        <form className={styles.search} onSubmit={event => { event.preventDefault(); setAppliedSearch(searchText.trim()); setPage(1); }}>
          <Search size={21} aria-hidden="true" />
          <Input aria-label="Buscar por nombre, cédula, folio o Sadmin" placeholder="Buscar por nombre, cédula o crédito" value={searchText} maxLength={100} onChange={event => setSearchText(event.target.value)} />
          <button type="submit" className={styles.searchSubmit} aria-label="Buscar solicitudes"><ArrowRight size={18} aria-hidden="true" /></button>
        </form>
        <Select aria-label="Filtrar tipo" value={typeFilter} className={styles.typeFilter} onChange={event => { setTypeFilter(event.target.value); setPage(1); }}><option value="">Todos los tipos</option><option value="EXCEPCION">Excepción</option><option value="PRORROGA">Prórroga</option></Select>
        <Button variant="secondary" className={styles.refresh} title="Actualizar" aria-label="Actualizar" onClick={() => setReload(value => value + 1)} disabled={loading}><RefreshCw size={19} aria-hidden="true" /></Button>
      </div>
      <section id="mora-results" role="tabpanel" aria-label={tabs.find(tab => tab.value === status)?.label || states[status as MoraExceptionStatus]} aria-busy={loading}>
        {loading ? <LoadingState label="Cargando solicitudes de excepción…" /> : listError ? <div className={styles.listError}><p role="alert">{listError}</p><Button variant="secondary" onClick={() => setReload(value => value + 1)}>Reintentar</Button></div> : !list?.items.length ? <EmptyState title="Sin solicitudes" description="No se encontraron solicitudes con estos filtros." /> :
          <DataTable className={styles.tableScroll}><table className={styles.table}><thead><tr><th scope="col">Cliente / Crédito</th><th scope="col">Tipo</th><th scope="col">Estado</th><th scope="col">Vencimiento</th><th scope="col">Responsable</th><th scope="col"><span className="sr-only">Detalle</span></th></tr></thead>
            <tbody>{list.items.map(item => <tr key={item.id}>
              <td><strong className={styles.clientName}>{item.credit?.clienteNombre || "Sin nombre registrado"}</strong><span className={styles.document}>CC {identifier(item.credit?.clienteDocumento)}</span><CreditNumber number={item.credit?.numeroSadmin} /><span className={styles.folio}>Folio: {item.credit?.folio || "Sin registro"}</span></td>
              <td>{item.type === "PRORROGA" ? "Prórroga" : "Excepción"}</td>
              <td><StatusPill tone={tone(item.status)} className={styles.status}>{states[item.status]}</StatusPill></td>
              <td>{expiry(item.expiresOn)}</td><td>{item.decidedByName || item.createdByName}</td>
              <td><Button variant="secondary" className={styles.detailButton} onClick={() => { setDetailId(item.id); setCreateOpen(false); setError(""); setNotice(""); }}>Ver detalle <ChevronRight size={17} aria-hidden="true" /></Button></td>
            </tr>)}</tbody></table></DataTable>}
      </section>
      <footer className={styles.pagination}>
        <span aria-live="polite">{loading ? "Cargando…" : listError ? "Resultados no disponibles" : `Mostrando ${from} – ${to} de ${total.toLocaleString("es-CO")} solicitudes`}</span>
        <div className={styles.pageActions}>
          <Select aria-label="Solicitudes por página" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 25, 50, 100].map(value => <option key={value} value={value}>{value} por página</option>)}</Select>
          <Button variant="secondary" aria-label="Página anterior" disabled={loading || Boolean(listError) || currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} aria-hidden="true" /></Button>
          <span className={styles.currentPage} aria-label={`Página ${currentPage} de ${totalPages}`}>{currentPage}</span>
          <Button variant="secondary" aria-label="Página siguiente" disabled={loading || Boolean(listError) || currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} aria-hidden="true" /></Button>
        </div>
      </footer>
    </Card>
    <Link href="/dashboard/aprobaciones/cartera-mora" className={styles.portfolioLink}>Consultar cartera en mora <ArrowRight size={17} aria-hidden="true" /></Link>

    <FinserSidePanel open={createOpen} title="Nueva solicitud" closeLabel="Cerrar formulario" busy={saving} onClose={() => { if (!submitting.current) setCreateOpen(false); }}>
      <div className={styles.panelContent}>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <form onSubmit={loadCandidate} className={styles.candidateSearch}><Input aria-label={centralAdmin ? "Buscar crédito" : "Buscar crédito en mora"} placeholder="Cédula, crédito o IMEI" value={query} onChange={event => { setQuery(event.target.value); setCandidateSearched(false); }} maxLength={100} /><Button type="submit" variant="secondary" disabled={searching || saving || query.trim().length < 2} aria-label="Buscar crédito"><Search size={19} aria-hidden="true" /></Button></form>
        {searching ? <LoadingState label="Buscando créditos…" /> : candidateSearched && !candidates.length ? <p role="status" className={styles.muted}>No se encontraron créditos.</p> : candidates.length > 0 && <div className={styles.candidates}>{candidates.map(item => <button key={item.id} type="button" onClick={() => { setCreditId(item.id); setError(""); }} disabled={saving} className={creditId === item.id ? styles.selectedCandidate : ""}><strong>{item.clienteNombre}</strong><span>CC {identifier(item.clienteDocumento)}</span><span>{item.numeroSadmin ? `Sadmin: ${item.numeroSadmin}` : "PENDIENTE SADMIN"}</span><span>Folio: {item.folio}</span></button>)}</div>}
        {preflightLoading ? <LoadingState label={centralAdmin ? "Cargando crédito…" : "Verificando cuota y reglas…"} /> : preflight?.credit && selectedCreditLoaded && <>
          <div className={styles.selectedCredit}><strong>{preflight.credit.clienteNombre}</strong><p>CC {identifier(preflight.credit.clienteDocumento)}</p><CreditNumber number={preflight.credit.numeroSadmin} /><p>Folio: {preflight.credit.folio}</p><p>{preflight.credit.aliadoNombre} · {preflight.credit.equipo}</p><p>IMEI: {identifier(preflight.credit.imei)}</p><p>Vencido: <strong>{money(preflight.credit.valorVencido)}</strong> · {preflight.credit.diasMora} días de mora</p></div>
          <form onSubmit={submit} className={styles.form}>
            <label>Tipo<Select value={kind} onChange={event => setKind(event.target.value as MoraExceptionType)} disabled={saving}><option value="EXCEPCION">Excepción de mora</option><option value="PRORROGA">Prórroga de pago</option></Select></label>
            {centralAdmin ? <>
              <label className={styles.checkbox}><input type="checkbox" checked={noExpiry} onChange={event => setNoExpiry(event.target.checked)} disabled={saving} /> Sin vencimiento</label>
              {!noExpiry && <label>Vencimiento<Input type="date" value={expiresOn} onChange={event => setExpiresOn(event.target.value)} min={today} required disabled={saving} /></label>}
              <label>Nota (opcional)<textarea className="fp-ui-input" placeholder="Agrega un motivo o una observación si lo necesitas" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={saving} /></label>
              <p className={styles.muted}>Se autoriza al guardar. Si existe una excepción vigente, se reemplaza y ambas quedan en el historial.</p>
              <Button type="submit" disabled={saving || !allowed}>{saving ? "Guardando…" : "Guardar excepción"}</Button>
            </> : <>
              {eligibility?.regularInstallment && <p>Cuota {eligibility.regularInstallment.number} · Fecha regular {date(eligibility.regularInstallment.dueDate)}</p>}
              {kind === "PRORROGA" && <p className={styles.notice}>Fecha máxima permitida: <strong>{date(eligibility?.maxExpiresOn || null)}</strong>. La prórroga se solicita después del 02 o 17 y admite máximo 4 días calendario.</p>}
              {blockedReason && <p className={styles.warning} role="status">{blockedReason}</p>}
              <label>Vencimiento<Input type="date" value={expiresOn} onChange={event => setExpiresOn(event.target.value)} min={today} max={maxDate} required disabled={saving} /></label>
              <label>Valor que se compromete a pagar<Input type="number" min="1" step="0.01" value={promiseAmount} onChange={event => setPromiseAmount(event.target.value)} required disabled={saving} /></label>
              <label>Fecha del compromiso<Input type="date" min={today} max={expiresOn || maxDate} value={promiseDate} onChange={event => setPromiseDate(event.target.value)} required disabled={saving} /></label>
              <label>Motivo<Input value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={500} required disabled={saving} /></label>
              <label>Observación<textarea className="fp-ui-input" value={observation} onChange={event => setObservation(event.target.value)} minLength={5} maxLength={2000} required disabled={saving} /></label>
              <p className={styles.muted}>Los soportes se adjuntan en el detalle después de enviar. La solicitud queda pendiente del responsable autorizado.</p>
              <Button type="submit" disabled={saving || !allowed}>{saving ? "Enviando…" : "Enviar a revisión"}</Button>
            </>}
          </form>
        </>}
      </div>
    </FinserSidePanel>

    <FinserSidePanel open={Boolean(detailId)} title="Detalle de la solicitud" closeLabel="Cerrar detalle" busy={saving || Boolean(confirm)} onClose={() => { if (!submitting.current && !confirm) setDetailId(null); }}>
      <div className={styles.panelContent}>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {detailLoading ? <LoadingState label="Cargando historial…" /> : detailError ? <div className={styles.listError}><p role="alert">{detailError}</p><Button variant="secondary" onClick={() => setReload(value => value + 1)}>Reintentar</Button></div> : detail && <>
          <StatusPill tone={tone(detail.item.status)}>{states[detail.item.status]}</StatusPill>
          <section className={styles.detailIdentity}><h3>{detailCredit?.clienteNombre || "Sin nombre registrado"}</h3><p>CC {identifier(detailCredit?.clienteDocumento)}</p><p>Teléfono: {identifier(detailCredit?.clienteTelefono)}</p><CreditNumber number={detailCredit?.numeroSadmin} /><p>Folio: {detailCredit?.folio || "Sin registro"}</p><p>{detailCredit?.equipo || "Equipo sin registro"}</p><p>IMEI: {identifier(detailCredit?.imei)}</p><p>Aliado: {detailCredit?.aliadoNombre || "Sin registro"}</p></section>
          <dl className={styles.details}><div><dt>Tipo</dt><dd>{detail.item.type === "PRORROGA" ? "Prórroga" : "Excepción"}</dd></div><div><dt>Vencimiento</dt><dd>{expiry(detail.item.expiresOn)}</dd></div>{detail.item.installmentNumber !== null && <div><dt>Cuota regular</dt><dd>{detail.item.installmentNumber} · {date(detail.item.installmentDueDate)}</dd></div>}{!detail.item.centralDirect && detail.item.promiseAmount !== null && <><div><dt>Compromiso</dt><dd>{money(detail.item.promiseAmount)} · {date(detail.item.promiseDate)}</dd></div><div><dt>Pago recibido</dt><dd>{money(detail.item.paidTowardPromise)}</dd></div></>}</dl>
          <section className={styles.reason}><h3>Motivo</h3><p>{detail.item.reason || "Sin nota registrada"}</p>{detail.item.observation && <><h3>Observación</h3><p>{detail.item.observation}</p></>}</section>
          <dl className={styles.details}><div><dt>Solicitada por</dt><dd>{detail.item.createdByName}</dd></div><div><dt>Solicitud</dt><dd>{date(detail.item.submittedAt || detail.item.createdAt, true)}</dd></div>{detail.item.decidedByName && <div><dt>Responsable de decisión</dt><dd>{detail.item.decidedByName}</dd></div>}{detail.item.decidedAt && <div><dt>Decisión</dt><dd>{date(detail.item.decidedAt, true)}</dd></div>}{detail.item.decisionReason && <div className={styles.fullWidth}><dt>Motivo de decisión</dt><dd>{detail.item.decisionReason}</dd></div>}</dl>
          {detail.item.cooldownBypassed && <p className={styles.warning}>Enfriamiento omitido por autorización: {detail.item.cooldownBypassReason}</p>}
          {detail.item.conditionStatus === "FULFILLED" && <Badge tone="positive">Compromiso cumplido</Badge>}
          {detail.item.conditionStatus === "BREACHED" && <Badge tone="danger">Compromiso incumplido</Badge>}
          <MoraSupports key={detail.item.id} creditoId={detail.item.creditoId} subjectKind="EXCEPCION" subjectId={detail.item.id} defaultOpen={!centralAdmin} />
          <div className={styles.form}><label>{centralAdmin ? "Observación (opcional)" : "Observación o motivo de decisión"}<textarea className="fp-ui-input" value={decisionReason} onChange={event => { setDecisionReason(event.target.value); changeKey.current = null; }} minLength={centralAdmin ? undefined : 5} maxLength={1000} disabled={saving} /></label>
            <div className={styles.management}><Button variant="secondary" disabled={saving || decisionReason.trim().length < (centralAdmin ? 1 : 5)} onClick={() => void change("OBSERVE")}>Guardar observación</Button>{centralAdmin && detail.item.status === "PENDING" && <><Button disabled={saving} onClick={() => setConfirm("APPROVE")}>Aprobar</Button><Button variant="danger" disabled={saving} onClick={() => setConfirm("REJECT")}>Rechazar</Button></>}</div>
          </div>
          {!centralAdmin && detail.item.status === "PENDING" && <p className={styles.muted}>La decisión corresponde al administrador central autorizado.</p>}
          <section className={styles.history}><h3>Historial de decisiones y responsables</h3><ol>{detail.history.map(item => <li key={item.id}><strong>{actions[item.action]}</strong><p>{date(item.createdAt, true)} · {item.actorName}</p><p>Resultado: {states[item.toStatus]}</p><p className={styles.muted}>{eventReason(item.payload)}</p></li>)}</ol></section>
        </>}
      </div>
      <ConfirmDialog open={Boolean(confirm)} title={confirm === "APPROVE" ? "Aprobar solicitud" : "Rechazar solicitud"} description={decisionReason.trim() ? `Se registrará tu decisión y el motivo: ${decisionReason}` : "Se registrará la decisión del administrador central con tu usuario, fecha y hora."} confirmLabel={confirm === "APPROVE" ? "Confirmar aprobación" : "Confirmar rechazo"} danger={confirm === "REJECT"} busy={saving} onCancel={() => { if (!submitting.current) setConfirm(null); }} onConfirm={() => { if (confirm) void change(confirm); }} />
    </FinserSidePanel>
  </main>;
}
