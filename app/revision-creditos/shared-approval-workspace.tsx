"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, ChevronDown, FileText, FolderOpen, ListFilter, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LoadingState, Tabs } from "@/app/_components/finser-ui";
import type { ApprovalDetail, ApprovalQueueItem, ApprovalView } from "@/app/dashboard/aprobaciones/approval-client";
import { PAYMENT_FREQUENCY_OPTIONS } from "@/lib/credit-factory";
import LastPdfPagePreview from "@/app/dashboard/aprobaciones/last-pdf-page-preview";
import SharedEvidenceGallery from "./shared-evidence-gallery";
import SharedNoveltyHistory from "./shared-novelty-history";
import styles from "./shared-review.module.css";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
const calendar = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const amount = (value: number | null | undefined) => value != null && Number.isFinite(value) ? money.format(value) : "No disponible";
const date = (value: string | null | undefined) => value && Number.isFinite(new Date(value).getTime()) ? dateTime.format(new Date(value)) : "No disponible";
function firstPayment(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "No disponible";
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? calendar.format(parsed) : "No disponible";
}
function statusLabel(item: ApprovalQueueItem) {
  if (item.status === "APPROVED") return "Aprobado";
  if (item.reissue?.blocked) return "Firma pendiente";
  if (item.novelty?.status === "WAITING_ALLY") return "Novedad al aliado";
  if (item.novelty?.status === "RESPONDED") return "Corrección por revisar";
  return "Pendiente de revisión";
}

type Props = {
  view: ApprovalView; counts: { pending: number; approved: number } | null; query: string;
  items: ApprovalQueueItem[]; selectedId: number | null; selectedItem: ApprovalQueueItem | null;
  detail: ApprovalDetail | null; queueLoaded: boolean; searching: boolean; searchError: string; nextCursor: string | null;
  loadingDetail: boolean; detailError: string; busy: boolean; correctionDisabled: boolean;
  notice: { text: string; warning: boolean } | null;
  onSelect: (id: number) => void; onView: (view: ApprovalView) => void; onSearch: (query: string) => void;
  onRefresh: () => void; onMore: () => void; onBack: () => void; onRetryDetail: () => void;
  onUpdated: () => Promise<void>; onCorrectionBusy: (busy: boolean) => void;
  callPanel: ReactNode; noveltyPanel: ReactNode; signaturePanel: ReactNode; approvalPanel: ReactNode; confirmationDialog: ReactNode;
};

export default function SharedApprovalWorkspace(props: Props) {
  const [searchText, setSearchText] = useState(props.query);
  const [documentTab, setDocumentTab] = useState("evidence");
  const { detail, selectedId, selectedItem, busy, view } = props;
  const showHistory = Boolean(detail?.review.required && selectedItem && !selectedItem.paid);
  const activeTab = documentTab === "history" && !showHistory ? "evidence" : documentTab;
  const tabs = [{ id: "evidence", label: "Evidencias" }, { id: "document", label: "Documento firmado" }, ...(showHistory ? [{ id: "history", label: "Historial" }] : [])];
  const facts = detail ? [
    ["Score", detail.score ?? detail.scoreLabel ?? "No disponible"],
    ["Valor de venta", amount(detail.valorVenta)], ["Inicial", amount(detail.cuotaInicial)],
    ["Crédito autorizado", amount(detail.creditoAutorizado)],
    ["Plazo de financiación", detail.numeroCuotas != null && Number.isSafeInteger(detail.numeroCuotas) && detail.numeroCuotas > 0 ? `${detail.numeroCuotas} ${detail.numeroCuotas === 1 ? "cuota" : "cuotas"}` : "No disponible"],
    ["Frecuencia", PAYMENT_FREQUENCY_OPTIONS.find(item => item.value === detail.frecuenciaPago?.trim().toUpperCase())?.label || "No disponible"],
    ["Valor de cuota", amount(detail.valorCuota)], ["Primer pago", firstPayment(detail.fechaPrimerPago)],
  ] : [];

  return <main className={styles.main}>
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}>Revisión de expedientes</p><h1>Muro de aprobaciones</h1></div>
      <Button variant="secondary" disabled={busy || props.searching || props.loadingDetail} onClick={props.onRefresh}><RefreshCw size={16} aria-hidden="true" />Actualizar</Button>
    </div>
    <div className={styles.toolbar}>
      <Tabs aria-label="Vistas de aprobaciones" className={styles.viewTabs}>
        {(["pending", "approved"] as const).map(tab => <button key={tab} id={`shared-view-${tab}`} type="button" role="tab" aria-selected={view === tab} aria-controls="shared-approval-view" tabIndex={view === tab ? 0 : -1} disabled={busy} onClick={() => props.onView(tab)} onKeyDown={event => {
          if (busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const next = event.key === "Home" ? "pending" : event.key === "End" ? "approved" : view === "pending" ? "approved" : "pending";
          props.onView(next); document.getElementById(`shared-view-${next}`)?.focus();
        }}>{tab === "pending" ? "Pendientes" : "Aprobadas"}<span className={styles.count}>{props.counts ? props.counts[tab].toLocaleString("es-CO") : "—"}</span></button>)}
      </Tabs>
      <form className={styles.search} onSubmit={event => { event.preventDefault(); if (!busy) props.onSearch(searchText.trim()); }}>
        <label className="sr-only" htmlFor="shared-approval-search">Buscar por cliente, folio o aliado</label>
        <Input id="shared-approval-search" type="search" placeholder="Cliente, folio o aliado" autoComplete="off" maxLength={100} value={searchText} disabled={busy} onChange={event => setSearchText(event.target.value)} />
        <Button variant="secondary" type="submit" disabled={busy || props.searching} aria-label="Buscar expedientes"><Search size={18} aria-hidden="true" /></Button>
        {props.query ? <Button variant="ghost" disabled={busy} onClick={() => { setSearchText(""); props.onSearch(""); }}>Limpiar</Button> : null}
      </form>
    </div>
    {props.notice ? <div role={props.notice.warning ? "alert" : "status"} className={`${styles.notice} ${props.notice.warning ? styles.warning : styles.positive}`}>{props.notice.text}</div> : null}
    {busy ? <p className={styles.busyNote} role="status">Termina o cancela la acción en curso antes de cambiar de expediente.</p> : null}
    <div id="shared-approval-view" role="tabpanel" aria-labelledby={`shared-view-${view}`} className={`${styles.workspace} ${selectedId ? styles.hasSelection : ""}`}>
      <Card className={styles.queue} aria-label="Lista de expedientes">
        <div className={styles.queueHeading}><h2>Expedientes</h2><span><ListFilter size={14} aria-hidden="true" />{view === "pending" ? "Más antiguos primero" : "OK más recientes"}</span>{props.query ? <p>Resultados para «{props.query}»</p> : null}</div>
        <div className={styles.listScroll}>
          {props.searchError ? <div role="alert" className={styles.inlineError}>{props.searchError}<Button variant="ghost" disabled={busy || props.searching} onClick={props.onRefresh}>Reintentar</Button></div> : null}
          {props.searching ? <div className={styles.listLoading}><LoadingState label="Actualizando expedientes..." /></div> : null}
          {!props.items.length && props.queueLoaded && !props.searching && !props.searchError ? <EmptyState title={props.query ? "Sin resultados" : view === "pending" ? "No hay pendientes" : "No hay aprobadas"} description={props.query ? "Prueba con otro cliente, folio o aliado." : view === "pending" ? "Los créditos que necesiten revisión aparecerán aquí." : "Aquí aparecerán los OK para liquidación vigentes."} /> : null}
          <ul className={styles.list}>{props.items.map(item => <li key={item.id}><button type="button" aria-label={`Revisar crédito ${item.folio}`} aria-current={selectedId === item.id ? "true" : undefined} className={`${styles.row} ${selectedId === item.id ? styles.selected : ""}`} disabled={busy} onClick={() => props.onSelect(item.id)}>
            <strong>{item.clienteNombre}</strong><span className={styles.document}>Cédula: {item.clienteDocumento?.trim() || "No disponible"}</span><span className={styles.folio}>{item.folio}</span><span>{item.aliadoNombre}{item.sedeNombre ? ` · ${item.sedeNombre}` : ""}</span><span className={styles.rowDate}>{date(item.fechaCredito)}</span>
            <Badge tone={item.status === "APPROVED" ? "positive" : "warning"}>{statusLabel(item)}</Badge>
          </button></li>)}</ul>
          {props.nextCursor ? <div className={styles.more}><Button variant="secondary" disabled={busy || props.searching} onClick={props.onMore}>Cargar más expedientes</Button></div> : null}
        </div>
        <div className={styles.queueFooter}>{props.items.length} visibles{props.counts ? ` de ${props.counts[view].toLocaleString("es-CO")}` : ""}</div>
      </Card>
      <div className={styles.detailColumn}>
        {selectedId ? <div className={styles.back}><Button variant="ghost" disabled={busy} onClick={props.onBack}><ArrowLeft size={16} aria-hidden="true" />Volver a la lista</Button></div> : null}
        {props.loadingDetail && !detail ? <Card className={styles.placeholder}><LoadingState label="Cargando el expediente seleccionado..." /></Card> : props.detailError ? <Card className={styles.placeholder}><p role="alert">{props.detailError}</p><Button variant="secondary" disabled={busy} onClick={props.onRetryDetail}>Reintentar expediente</Button></Card> : detail ? <Card className={styles.dossier} aria-busy={props.loadingDetail} aria-label={`Expediente del crédito ${detail.folio}`}>
          {props.loadingDetail ? <p role="status" className="px-5 pt-3 text-sm text-[var(--fp-muted)]">Actualizando expediente...</p> : null}<div className={styles.dossierHeading}><div><p>{detail.folio}</p><h2>{detail.clienteNombre?.trim() || "No disponible"}</h2><span>{detail.aliadoNombre}{selectedItem?.id === detail.id && selectedItem.sedeNombre ? ` · ${selectedItem.sedeNombre}` : ""}</span><p>{date(detail.fechaCredito)}</p></div><Badge tone={view === "approved" ? "positive" : "warning"}>{view === "approved" ? "Aprobado" : "Pendiente"}</Badge></div>
          <details className={styles.customer}><summary>Datos del cliente<ChevronDown size={16} aria-hidden="true" /></summary><dl>{[["Nombre", detail.clienteNombre], ["Cédula", detail.clienteDocumento], ["Correo", detail.clienteCorreo], ["Teléfono", detail.clienteTelefono]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value?.trim() || "No disponible"}</dd></div>)}</dl></details>
          <dl className={styles.financial}>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <Tabs aria-label="Documentación del expediente" className={styles.documentTabs}>{tabs.map(tab => <button type="button" role="tab" id={`document-tab-${tab.id}`} key={tab.id} aria-selected={activeTab === tab.id} aria-controls={`document-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => setDocumentTab(tab.id)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); const current = tabs.findIndex(item => item.id === activeTab); const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
            setDocumentTab(tabs[index].id); document.getElementById(`document-tab-${tabs[index].id}`)?.focus();
          }}>{tab.label}</button>)}</Tabs>
          <div id="document-panel-evidence" role="tabpanel" aria-labelledby="document-tab-evidence" hidden={activeTab !== "evidence"} className={styles.documentBody}><SharedEvidenceGallery key={detail.id} detail={detail} readOnly={view === "approved"} disabled={props.correctionDisabled} onUpdated={props.onUpdated} onBusyChange={props.onCorrectionBusy} /></div>
          <div id="document-panel-document" role="tabpanel" aria-labelledby="document-tab-document" hidden={activeTab !== "document"} className={styles.documentBody}><div className={styles.documentTitle}><FileText size={17} aria-hidden="true" /><h3>Documento firmado</h3></div>{detail.document.available ? <><p className={styles.documentName}>{detail.document.fileName || "Documento de FirmaSeguro"}</p><LastPdfPagePreview key={`${detail.id}:${detail.review.reviewHash}`} href={detail.document.href} folio={detail.folio} compact /></> : <EmptyState title="Documento no disponible" description="La firma debe estar disponible antes del OK para liquidación." />}</div>
          {showHistory ? <div id="document-panel-history" role="tabpanel" aria-labelledby="document-tab-history" hidden={activeTab !== "history"} className={styles.documentBody}>{activeTab === "history" ? <SharedNoveltyHistory key={`${detail.id}:${detail.review.reviewHash}`} creditId={detail.id} evidence={detail.evidence} /> : null}</div> : null}
        </Card> : <Card className={styles.placeholder}><FolderOpen size={36} aria-hidden="true" /><h2>Selecciona un expediente</h2><p>Abre un crédito de la lista para revisar sus documentos y continuar.</p></Card>}
      </div>
      <aside className={styles.actions} aria-label="Acciones de revisión">
        {detail ? <><div className={styles.actionsScroll}>{props.callPanel}{props.noveltyPanel}{view === "pending" ? props.signaturePanel : <Card className={styles.approvedSummary}><div className={styles.documentTitle}><FileText size={17} aria-hidden="true" /><h2>Firma del contrato</h2></div><Badge tone={detail.document.available ? "positive" : "warning"}>{detail.document.available ? "Documento firmado disponible" : "Documento no disponible"}</Badge></Card>}</div>{view === "pending" ? props.approvalPanel : <Card className={styles.approvedSummary}><div className={styles.documentTitle}><ShieldCheck size={18} aria-hidden="true" /><h2>OK para liquidación</h2></div><Badge tone="positive"><CheckCircle2 size={14} aria-hidden="true" />Aprobación vigente</Badge><p>{date(detail.review.approvedAt)}</p>{detail.review.approvedByName ? <p>Registro: {detail.review.approvedByName}</p> : null}</Card>}</> : <Card className={styles.placeholder}><ShieldCheck size={30} aria-hidden="true" /><h2>Revisión para liquidación</h2><p>Las acciones del crédito seleccionado aparecerán aquí.</p></Card>}
      </aside>
    </div>
    {props.confirmationDialog}
  </main>;
}
