"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Expand, FileText, ImageOff, RefreshCw, ShieldCheck } from "lucide-react";
import SharedApprovalWorkspace from "@/app/revision-creditos/shared-approval-workspace";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { PAYMENT_FREQUENCY_OPTIONS } from "@/lib/credit-factory";
import LastPdfPagePreview from "./last-pdf-page-preview";
import ApprovalEvidenceCorrection from "./approval-evidence-correction";
import ApprovalSignatureReissue from "./approval-signature-reissue";
import ApprovalCallRecording from "./approval-call-recording";
import ApprovalNoveltyPanel from "./approval-novelty-panel";
import { Badge, Button, Card, DataTable, EmptyState, LoadingState, MetricCard, PageHeader, StatusPill, Tabs } from "@/app/_components/finser-ui";
import { ApprovalRequestError, approveCreditReview, readApprovalCredit, readApprovalQueue, mergeApprovalQueuePage, type ApprovalDetail, type ApprovalQueueItem, type ApprovalStatus, type ApprovalView } from "./approval-client";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const calendarDates = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });

function dateLabel(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dates.format(date) : "No disponible";
}

function calendarDateLabel(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "No disponible";
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? calendarDates.format(date) : "No disponible";
}

function amountLabel(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? money.format(value) : "No disponible";
}

function frequencyLabel(value: string | null) {
  return PAYMENT_FREQUENCY_OPTIONS.find((option) => option.value === value?.trim().toUpperCase())?.label ?? "No disponible";
}

function ReviewStatus({ status, required }: { status: ApprovalStatus; required: boolean }) {
  if (!required || status === "NOT_REQUIRED") return <StatusPill>No requiere aprobación</StatusPill>;
  return <StatusPill tone={status === "APPROVED" ? "positive" : "warning"}>{status === "APPROVED" ? "Aprobado" : "Pendiente de revisión"}</StatusPill>;
}

function EvidencePhoto({ item, clientName }: { item: ApprovalDetail["evidence"][number]; clientName: string }) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const href = retry ? `${item.href}${item.href.includes("?") ? "&" : "?"}retry=${retry}` : item.href;

  return (
    <article className="overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)]">
      {item.available && !failed ? (
        <a href={item.href} target="_blank" rel="noopener noreferrer" className="group relative block aspect-[4/3] bg-[var(--fp-bg)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--fp-graphite)]" aria-label={`Ampliar ${item.label}`}>
          {/* Authenticated evidence must be fetched directly with the analyst's session. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={href} alt={`${item.label} de ${clientName}`} className="h-full w-full object-contain" onError={() => setFailed(true)} />
          <span className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-[var(--fp-radius-sm)] bg-[var(--fp-graphite)] text-white"><Expand className="h-4 w-4" aria-hidden="true" /></span>
        </a>
      ) : (
        <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-[var(--fp-bg)] px-3 text-center text-sm text-[var(--fp-muted)]">
          <ImageOff className="h-6 w-6" aria-hidden="true" />
          <span>{failed ? "No se pudo cargar la foto" : "Foto no disponible"}</span>
          {failed ? <Button variant="ghost" onClick={() => { setRetry((value) => value + 1); setFailed(false); }}>Reintentar</Button> : null}
        </div>
      )}
      <h3 className="px-3 py-4 text-sm font-semibold">{item.label}</h3>
    </article>
  );
}

type Confirmation = { id: number; folio: string; clienteNombre: string; clienteDocumento: string | null; revision: number; reviewHash: string; recordingId: string };

export default function ApprovalConsole({ shared = false, redesigned = false }: { shared?: boolean; redesigned?: boolean } = {}) {
  const modern = shared || redesigned;
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState<{ pending: number; approved: number } | null>(null);
  const [selectedItem, setSelectedItem] = useState<ApprovalQueueItem | null>(null);
  const loadedPages = useRef(1);
  const [view, setView] = useState<ApprovalView>("pending");
  const [callBusy, setCallBusy] = useState(false);
  const [items, setItems] = useState<ApprovalQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasExtraPages, setHasExtraPages] = useState(false);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<{ text: string; warning: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [signatureBusy, setSignatureBusy] = useState(false);
  const [noveltyBusy, setNoveltyBusy] = useState(false);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [rereviewed, setRereviewed] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const busy = saving || Boolean(confirmation) || correctionBusy || signatureBusy || noveltyBusy || callBusy;

  useEffect(() => () => {
    searchController.current?.abort();
    detailController.current?.abort();
  }, []);

  useEffect(() => {
    if (!modern || !busy) return;
    const preventLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, [modern, busy]);

  async function loadDetail(id: number) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setLoadingDetail(true);
    setDetailError("");
    try {
      const nextDetail = await readApprovalCredit(id, controller.signal);
      if (controller.signal.aborted) return;
      if (nextDetail.review.status !== (view === "approved" ? "APPROVED" : "PENDING")) {
        setItems((current) => current.filter((item) => item.id !== id)); setSelectedId(null); setSelectedItem(null); setDetail(null);
        setNotice({ text: view === "pending" ? `Crédito ${nextDetail.folio} aprobado. Puedes consultarlo en Aprobadas.` : `El crédito ${nextDetail.folio} ya no tiene una aprobación vigente. Consulta Pendientes por aprobar.`, warning: view === "approved" });
        return nextDetail;
      }
      if (modern && detail?.id === nextDetail.id && (nextDetail.review.revision !== detail.review.revision || nextDetail.review.reviewHash !== detail.review.reviewHash)) {
        setReviewChanged(true); setRereviewed(false);
        setNotice({ text: "El expediente cambió. Revisa los documentos actualizados antes de confirmar el OK.", warning: true });
      }
      setDetail(nextDetail);
      setItems((current) => current.map((item) => item.id === id ? { ...item, status: nextDetail.review.status, required: nextDetail.review.required } : item));
      return nextDetail;
    } catch (error) {
      if (controller.signal.aborted) return;
      setDetailError(error instanceof Error ? error.message : "No fue posible cargar el expediente.");
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }

  async function reloadAfterCorrection() {
    if (!detail) return;
    setConfirmation(null);
    const next = await loadDetail(detail.id);
    await loadQueue(null, modern);
    if (next && (next.review.revision !== detail.review.revision || next.review.reviewHash !== detail.review.reviewHash)) {
      setReviewChanged(true);
      setRereviewed(false);
      setNotice({ text: "El expediente se actualizó. Revisa las fotografías y la firma vigente antes de confirmar un nuevo OK.", warning: true });
    }
  }

  function selectCredit(id: number) {
    if (busy || submitting.current) return;
    const selected = items.find(item => item.id === id) || null;
    if (modern && !selected) return;
    setSelectedItem(selected);
    setSelectedId(id);
    setDetail(null);
    setConfirmation(null);
    setNotice(null);
    setReviewChanged(false);
    setRereviewed(false);
    void loadDetail(id);
  }

  function changeView(next: ApprovalView) {
    if (next === view || busy || submitting.current) return;
    searchController.current?.abort(); detailController.current?.abort();
    setSelectedId(null); setSelectedItem(null); setDetail(null); setItems([]); setNextCursor(null);
    loadedPages.current = 1;
    setHasExtraPages(false); setQueueLoaded(false); setLoadingDetail(false);
    setSearchError(""); setDetailError(""); setNotice(null); setConfirmation(null);
    setReviewChanged(false); setRereviewed(false); setView(next);
  }

  const loadQueue = useCallback(async (cursor: string | null = null, preservePages = false) => {
    searchController.current?.abort();
    const controller = new AbortController(); searchController.current = controller;
    setSearching(true); setSearchError("");
    try {
      const options = modern ? { query, counts: true } : undefined;
      const firstPage = await readApprovalQueue(cursor, controller.signal, view, options);
      let page = firstPage, rows = page.items, pages = 1;
      const targetPages = modern && preservePages && !cursor ? loadedPages.current : 1;
      while (page.nextCursor && pages < targetPages && !controller.signal.aborted) {
        page = await readApprovalQueue(page.nextCursor, controller.signal, view, options);
        rows = mergeApprovalQueuePage(rows, page.items, true, view); pages += 1;
      }
      if (controller.signal.aborted) return;
      loadedPages.current = cursor ? loadedPages.current + 1 : pages;
      setItems((current) => mergeApprovalQueuePage(current, rows, Boolean(cursor), view));
      if (modern) {
        setCounts(firstPage.counts || null);
        setSelectedItem(current => current ? rows.find(item => item.id === current.id) || current : null);
      }
      setNextCursor(page.nextCursor); setHasExtraPages(loadedPages.current > 1); setQueueLoaded(true);
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "No fue posible cargar el muro.");
    } finally { if (!controller.signal.aborted) setSearching(false); }
  }, [view, query, modern]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) void loadQueue(); });
    return () => { cancelled = true; searchController.current?.abort(); };
  }, [loadQueue]);

  // Refresh the visible first page while idle. Manual refresh restarts pagination.
  // A form in progress cancels background requests so its observed revision stays intact.
  useEffect(() => {
    if (busy || searching || loadingDetail || !queueLoaded || hasExtraPages) return;
    const controller = new AbortController();
    let fetching = false;
    const refresh = async () => {
      if (fetching || document.visibilityState === "hidden") return;
      fetching = true;
      try {
        const page = await readApprovalQueue(null, controller.signal, view, modern ? { query, counts: true } : undefined);
        const updated = selectedId ? await readApprovalCredit(selectedId, controller.signal) : null;
        if (controller.signal.aborted) return;
        setItems(page.items); setNextCursor(page.nextCursor); setSearchError("");
        if (modern) {
          setCounts(page.counts || null);
          setSelectedItem(current => current ? page.items.find(item => item.id === current.id) || current : null);
        }
        if (updated) {
          if (updated.review.status !== (view === "approved" ? "APPROVED" : "PENDING")) {
            setSelectedId(null); setSelectedItem(null); setDetail(null);
            setItems((current) => current.filter((item) => item.id !== updated.id));
            setNotice({ text: view === "pending" ? `Crédito ${updated.folio} aprobado. Puedes consultarlo en Aprobadas.` : `El crédito ${updated.folio} ya no tiene una aprobación vigente. Consulta Pendientes por aprobar.`, warning: view === "approved" });
          } else {
            setDetail(updated);
            if (detail && (updated.review.revision !== detail.review.revision || updated.review.reviewHash !== detail.review.reviewHash)) {
              setReviewChanged(true); setRereviewed(false);
              setNotice({ text: "El expediente cambió. Revisa las correcciones y la documentación vigente antes de dar el OK.", warning: true });
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "No se pudo actualizar el muro.");
      } finally { fetching = false; }
    };
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const focused = () => { void refresh(); };
    window.addEventListener("focus", focused);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener("focus", focused); };
  }, [busy, searching, loadingDetail, queueLoaded, hasExtraPages, selectedId, detail, view, query, modern]);

  function searchShared(value: string) {
    if (busy || submitting.current) return;
    const next = value.trim();
    if (next === query) { void loadQueue(null, true); return; }
    searchController.current?.abort(); detailController.current?.abort();
    loadedPages.current = 1;
    setSelectedId(null); setSelectedItem(null); setDetail(null); setItems([]); setCounts(null);
    setNextCursor(null); setHasExtraPages(false); setQueueLoaded(false); setLoadingDetail(false);
    setSearchError(""); setDetailError(""); setNotice(null); setConfirmation(null);
    setReviewChanged(false); setRereviewed(false); setQuery(next);
  }
  function refreshShared() {
    if (busy || submitting.current) return;
    void loadQueue(null, true);
    if (selectedId) void loadDetail(selectedId);
  }
  function backToList() {
    if (busy || submitting.current) return;
    detailController.current?.abort();
    setSelectedId(null); setSelectedItem(null); setDetail(null); setLoadingDetail(false); setDetailError("");
    setReviewChanged(false); setRereviewed(false);
  }
  const canConfirm = Boolean(view === "pending" && detail?.callRecording?.recording && detail?.review.required && detail.review.status === "PENDING" && detail.canApprove && !loadingDetail && !detailError && !searchError && !searching && !busy && (!reviewChanged || rereviewed));

  function requestApproval() {
    if (!detail || !detail.callRecording?.recording || !canConfirm || submitting.current) return;
    setNotice(null);
    setConfirmation({ id: detail.id, folio: detail.folio, clienteNombre: detail.clienteNombre, clienteDocumento: detail.clienteDocumento, revision: detail.review.revision, reviewHash: detail.review.reviewHash, recordingId: detail.callRecording.recording.id });
  }

  async function confirmApproval() {
    if (!confirmation || submitting.current || !detail || detail.id !== confirmation.id || detail.review.revision !== confirmation.revision || detail.review.reviewHash !== confirmation.reviewHash || detail.callRecording?.recording?.id !== confirmation.recordingId) return;
    submitting.current = true;
    setSaving(true);
    try {
      await approveCreditReview(confirmation.id, confirmation.revision, confirmation.reviewHash, confirmation.recordingId);
      setConfirmation(null);
      setNotice({ text: `Crédito ${confirmation.folio} aprobado para liquidación al aliado. Puedes consultarlo en Aprobadas.`, warning: false });
      setItems((current) => current.filter((item) => item.id !== confirmation.id));
      detailController.current?.abort(); setSelectedId(null); setSelectedItem(null); setDetail(null); setLoadingDetail(false);
      setReviewChanged(false); setRereviewed(false);
      await loadQueue();
    } catch (error) {
      setConfirmation(null);
      if (error instanceof ApprovalRequestError && error.status === 409) {
        setReviewChanged(true);
        setRereviewed(false);
        setNotice({ text: "El expediente cambió o ya no admite esta aprobación. Se actualizó la información: vuelve a revisar las fotos y el documento antes de confirmar.", warning: true });
      } else {
        setNotice({ text: error instanceof Error ? error.message : "No se pudo confirmar la aprobación.", warning: true });
      }
      // A failed request may have reached the server. Refresh before another explicit approval.
      await loadDetail(confirmation.id);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  if (modern) {
    const actionError = loadingDetail ? "Espera a que termine de cargar el expediente." : detailError || searchError || (searching ? "Actualizando la información del muro." : busy ? "Termina o cancela la acción en curso." : reviewChanged && !rereviewed ? "Confirma que revisaste nuevamente los documentos actualizados." : "");
    const correctionDisabled = saving || Boolean(confirmation) || signatureBusy || noveltyBusy || callBusy || loadingDetail || searching || Boolean(detailError);
    return <SharedApprovalWorkspace view={view} counts={counts} query={query} items={items} selectedId={selectedId} selectedItem={selectedItem} detail={detail}
      queueLoaded={queueLoaded} searching={searching} searchError={searchError} nextCursor={nextCursor} loadingDetail={loadingDetail} detailError={detailError} busy={busy} correctionDisabled={correctionDisabled} notice={notice}
      onSelect={selectCredit} onView={changeView} onSearch={searchShared} onRefresh={refreshShared} onMore={() => { if (!busy && nextCursor) void loadQueue(nextCursor); }} onBack={backToList} onRetryDetail={() => { if (selectedId && !busy) void loadDetail(selectedId); }} onUpdated={reloadAfterCorrection} onCorrectionBusy={setCorrectionBusy}
      callPanel={detail ? <ApprovalCallRecording key={detail.id} detail={detail} compact readOnly={view === "approved"} disabled={saving || Boolean(confirmation) || correctionBusy || signatureBusy || noveltyBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setCallBusy} /> : null}
      noveltyPanel={detail ? <ApprovalNoveltyPanel key={detail.id} detail={detail} compact readOnly={view === "approved"} disabled={saving || Boolean(confirmation) || correctionBusy || signatureBusy || callBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setNoveltyBusy} /> : null}
      signaturePanel={detail ? <ApprovalSignatureReissue key={detail.id} detail={detail} compact sharedAccess={shared} disabled={saving || Boolean(confirmation) || correctionBusy || noveltyBusy || callBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setSignatureBusy} /> : null}
      approvalPanel={detail && detail.review.required && detail.review.status === "PENDING" ? <Card data-approval-decision="true">
        <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck size={18} aria-hidden="true" />Dar OK para liquidación</h2>
        {detail.blockingReasons.length ? <><p className="mt-3 text-sm text-[var(--fp-muted)]">{detail.blockingReasons[0]}</p><details className="mt-3 text-sm"><summary className="min-h-10 cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-[var(--fp-graphite)]">Ver requisitos pendientes ({detail.blockingReasons.length})</summary><ul className="list-disc space-y-2 pb-2 pl-5 text-[var(--fp-danger)]">{detail.blockingReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details></> : <p className="mt-3 text-sm text-[var(--fp-muted)]">{detail.canApprove ? "Confirma el OK después de revisar los datos, las evidencias, la firma y la llamada." : "Actualiza el expediente para verificar los requisitos de aprobación."}</p>}
        {reviewChanged ? <label className="mt-3 flex min-h-10 items-start gap-2 text-sm"><input type="checkbox" checked={rereviewed} disabled={busy || loadingDetail || Boolean(detailError)} onChange={event => setRereviewed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--fp-graphite)]" />Revisé de nuevo las fotografías y el documento actualizado.</label> : null}
        {actionError ? <p className="mt-2 text-sm text-[var(--fp-muted)]">{actionError}</p> : null}
        <div className="mt-4"><Button className="w-full" onClick={requestApproval} disabled={!canConfirm}><CheckCircle2 size={17} aria-hidden="true" />{saving ? "Confirmando..." : "OK para liquidación"}</Button></div>
      </Card> : null}
      confirmationDialog={<ConfirmDialog open={Boolean(confirmation)} title="Aprobar para liquidación" description={confirmation ? `Confirma que revisaste el expediente de ${confirmation.clienteNombre}, cédula ${confirmation.clienteDocumento}, folio ${confirmation.folio}. Confirma que realizaste la llamada, guardaste su grabación y verificaste las correcciones. El OK habilitará este crédito para la liquidación al aliado y ${shared ? "quedará registrado por este acceso" : "quedará registrado con tu usuario"}.` : ""} confirmLabel="Confirmar OK para liquidación" busy={saving} onCancel={() => { if (!saving && !submitting.current) setConfirmation(null); }} onConfirm={() => void confirmApproval()} />} />;
  }

  return (
    <main className="space-y-6 p-4 text-[var(--fp-graphite)] sm:p-6 lg:p-8">
      <PageHeader eyebrow="Control documental" title="Muro de aprobaciones" description="Revisa los expedientes de todos los aliados y consulta las aprobaciones vigentes para liquidación." actions={<Button variant="secondary" disabled={busy || searching} onClick={() => void loadQueue()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar muro</Button>} />
      <Tabs role="tablist" aria-label="Vistas de aprobaciones">
        {(["pending", "approved"] as const).map((tab) => <button key={tab} id={"approval-tab-" + tab} role="tab" type="button" aria-selected={view === tab} aria-controls="approval-view" tabIndex={view === tab ? 0 : -1} disabled={busy} onClick={() => changeView(tab)} onKeyDown={(event) => {
          if (busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "pending" : event.key === "End" ? "approved" : view === "pending" ? "approved" : "pending";
          changeView(next); document.getElementById("approval-tab-" + next)?.focus();
        }}>{tab === "pending" ? "Pendientes por aprobar" : "Aprobadas"}</button>)}
      </Tabs>
      <div id="approval-view" role="tabpanel" aria-labelledby={"approval-tab-" + view} className="space-y-6">
      <p className="text-sm text-[var(--fp-muted)]">{view === "pending" ? "Los créditos más antiguos aparecen primero. Las correcciones del aliado vuelven a revisión del analista." : "Créditos con OK de liquidación vigente, del más reciente al más antiguo."}</p>
      {searchError ? <div role="alert" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-amber-soft)] p-4 text-sm">{searchError} Actualiza el muro para continuar.</div> : null}
      {searching ? <LoadingState label={view === "pending" ? "Cargando créditos pendientes..." : "Cargando aprobaciones..."} /> : null}
      {queueLoaded && !items.length && !searching && !searchError ? <Card><EmptyState title={view === "pending" ? "No hay créditos pendientes" : "No hay créditos aprobados"} description={view === "pending" ? "Los nuevos créditos y los expedientes que requieran otra revisión aparecerán aquí." : "Aquí aparecerán los créditos después de confirmar el OK para liquidación."} /></Card> : null}
      {items.length ? (
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--fp-border)] p-4 sm:px-6"><h2 className="font-semibold">{view === "pending" ? "Créditos por revisar" : "Aprobaciones vigentes"}</h2><p className="mt-1 text-sm text-[var(--fp-muted)]">{items.length} {items.length === 1 ? "crédito visible" : "créditos visibles"}{nextCursor ? " · Hay más créditos" : ""}</p></div>
          <DataTable className="max-w-full">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <thead className="bg-[var(--fp-bg)] text-[var(--fp-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Folio / cliente</th>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Aliado</th>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">{view === "pending" ? "Fecha del crédito" : "Aprobación"}</th>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Revisión</th>
                  <th scope="col" className="relative px-4 py-3 sm:px-6"><span className="sr-only">Seleccionar crédito</span></th>
                </tr>
              </thead>
              <tbody>{items.map((item) => (
                <tr key={item.id} className={`border-t border-[var(--fp-border)] ${selectedId === item.id ? "bg-[var(--fp-lime-soft)]" : ""}`}>
                  <td className="px-4 py-4 align-top sm:px-6"><strong>{item.folio}</strong><span className="mt-1 block text-[var(--fp-muted)]">{item.clienteNombre}</span></td>
                  <td className="px-4 py-4 align-top sm:px-6">{item.aliadoNombre}{item.sedeNombre ? <span className="mt-1 block text-[var(--fp-muted)]">{item.sedeNombre}</span> : null}</td>
                  <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">{dateLabel(view === "approved" ? item.approvedAt ?? null : item.fechaCredito)}{view === "approved" ? <span className="mt-1 block whitespace-normal text-[var(--fp-muted)]">{item.approvedByName || "Analista autorizado"}</span> : null}</td>
                  <td className="px-4 py-4 align-top sm:px-6"><div className="flex flex-col items-start gap-2"><ReviewStatus status={item.status} required={item.required} />
                    {item.paid ? <Badge>Incluido en liquidación</Badge> : null}
                    {item.novelty?.pendingCount ? <Badge tone="warning">{item.novelty.pendingCount} por corregir en el aliado</Badge> : null}
                    {item.novelty?.answeredCount ? <Badge tone="positive">Correcciones por revisar</Badge> : null}
                    {item.reissue?.blocked ? <Badge tone="warning">Firma pendiente</Badge> : null}
                  </div></td>
                  <td className="px-4 py-4 align-top sm:px-6"><Button variant="secondary" onClick={() => selectCredit(item.id)} disabled={busy || searching} aria-label={`${view === "pending" ? "Revisar" : "Ver"} crédito ${item.folio}`} aria-pressed={selectedId === item.id}>{selectedId === item.id ? "Seleccionado" : view === "pending" ? "Revisar" : "Ver expediente"}</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </DataTable>
          {nextCursor ? <div className="border-t border-[var(--fp-border)] p-4"><Button variant="secondary" disabled={busy || searching} onClick={() => void loadQueue(nextCursor)}>Cargar más créditos</Button></div> : null}
          {!selectedId && items.length > 1 ? <p className="p-4 text-sm text-[var(--fp-muted)]">Selecciona un folio para abrir su expediente.</p> : null}
        </Card>
      ) : null}

      {loadingDetail ? <LoadingState label="Cargando el expediente seleccionado..." /> : null}
      {detailError ? <Card className="flex flex-wrap items-center justify-between gap-4 p-4"><p role="alert" className="text-sm text-[var(--fp-danger)]">{detailError} Actualiza para continuar la revisión.</p><Button variant="secondary" disabled={busy || loadingDetail} onClick={() => { if (selectedId) void loadDetail(selectedId); }}><RefreshCw className="h-4 w-4" aria-hidden="true" />Reintentar</Button></Card> : null}
      {notice ? <div role={notice.warning ? "alert" : "status"} className={`rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] p-4 text-sm ${notice.warning ? "bg-[var(--fp-amber-soft)]" : "bg-[var(--fp-lime-soft)]"}`}>{notice.text}</div> : null}

      {detail ? (
        <section aria-label={`Expediente del crédito ${detail.folio}`} aria-busy={loadingDetail} className="space-y-6">
          <Card className="p-4 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--fp-muted)]">Crédito {detail.folio}</p>
                <h2 className="mt-1 break-words text-xl font-bold">{detail.clienteNombre?.trim() || "No disponible"}</h2>
                <p className="mt-2 text-sm text-[var(--fp-muted)]">{detail.aliadoNombre}</p>
                <p className="mt-1 text-sm text-[var(--fp-muted)]">{dateLabel(detail.fechaCredito)}</p>
              </div>
              <ReviewStatus status={detail.review.status} required={detail.review.required} />
            </div>
            <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
              {[["Cédula", detail.clienteDocumento], ["Correo", detail.clienteCorreo], ["Teléfono", detail.clienteTelefono], ["Dirección", detail.clienteDireccion]].map(([label, value]) => (
                <div key={label} className={`min-w-0 ${label === "Dirección" ? "sm:col-span-2 xl:col-span-3" : ""}`}><dt className="text-[var(--fp-muted)]">{label}</dt><dd className="mt-1 break-words font-medium">{value?.trim() || "No disponible"}</dd></div>
              ))}
            </dl>
            {detail.review.status === "APPROVED" ? <p className="mt-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />Aprobado por {detail.review.approvedByName || "analista autorizado"} · {dateLabel(detail.review.approvedAt)}</p> : null}
            {!detail.review.required ? <p className="mt-4 text-sm text-[var(--fp-muted)]">Este crédito no está sujeto a la nueva revisión para liquidación.</p> : null}
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Score" value={detail.score ?? detail.scoreLabel ?? "No disponible"} detail="Registrado al evaluar el crédito" />
            <MetricCard label="Valor de venta" value={amountLabel(detail.valorVenta)} />
            <MetricCard label="Inicial" value={amountLabel(detail.cuotaInicial)} />
            <MetricCard label="Crédito autorizado" value={amountLabel(detail.creditoAutorizado)} />
            <MetricCard label="Plazo de financiación" value={detail.numeroCuotas != null && Number.isSafeInteger(detail.numeroCuotas) && detail.numeroCuotas > 0 ? `${detail.numeroCuotas} ${detail.numeroCuotas === 1 ? "cuota" : "cuotas"}` : "No disponible"} detail={`Frecuencia: ${frequencyLabel(detail.frecuenciaPago)}`} />
            <MetricCard label="Valor de cuota" value={amountLabel(detail.valorCuota)} />
            <MetricCard label="Fecha de primer pago" value={calendarDateLabel(detail.fechaPrimerPago)} />
          </div>

          <Card className="p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Fotografías del expediente</h2><Badge>{detail.evidence.filter((item) => item.available).length} de {detail.evidence.length} disponibles</Badge></div>
            <p className="mb-4 text-sm text-[var(--fp-muted)]">Abre cada fotografía para revisarla en tamaño completo.</p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{detail.evidence.map((item) => <EvidencePhoto key={`${detail.id}:${detail.review.reviewHash}:${item.key}`} item={item} clientName={detail.clienteNombre} />)}</div>
            {view === "pending" ? <ApprovalEvidenceCorrection detail={detail} disabled={saving || Boolean(confirmation) || signatureBusy || noveltyBusy || callBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setCorrectionBusy} /> : null}
          </Card>

          <div className={`grid items-start gap-6 ${detail.review.required ? "xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]" : ""}`}>
            <Card role="region" aria-label="Documento firmado" className="min-w-0 p-4 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5" aria-hidden="true" />Documento firmado</h2></div>
              {detail.document.available ? <><p className="mb-3 break-words text-sm text-[var(--fp-muted)]">{detail.document.fileName || "Documento de FirmaSeguro"}</p><LastPdfPagePreview key={`${detail.id}:${detail.review.reviewHash}`} href={detail.document.href} folio={detail.folio} /></> : <EmptyState title="Documento firmado no disponible" description="El expediente debe contar con el documento firmado para completar la aprobación." />}
            </Card>

            {detail.review.required ? <aside aria-label="Acciones de revisión" className="min-w-0 space-y-6">
              <ApprovalCallRecording key={detail.id} detail={detail} readOnly={view === "approved"} disabled={saving || Boolean(confirmation) || correctionBusy || signatureBusy || noveltyBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setCallBusy} />
              {view === "pending" ? <ApprovalNoveltyPanel key={detail.id} detail={detail} disabled={saving || Boolean(confirmation) || correctionBusy || signatureBusy || callBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setNoveltyBusy} /> : null}
              {view === "pending" ? <ApprovalSignatureReissue detail={detail} disabled={saving || Boolean(confirmation) || correctionBusy || noveltyBusy || callBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setSignatureBusy} /> : null}
            </aside> : null}
          </div>

          {view === "pending" && detail.review.required && detail.review.status === "PENDING" ? (
            <Card className="p-4 sm:p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5" aria-hidden="true" />OK para liquidación</h2>
              <p className="mt-2 text-sm text-[var(--fp-muted)]">Confirma después de revisar los datos financieros, las fotografías, el documento firmado y la llamada al cliente. La grabación debe estar guardada y las novedades resueltas.</p>
              {detail.blockingReasons.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-[var(--fp-danger)]">{detail.blockingReasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul> : null}
              {!detail.canApprove && !detail.blockingReasons.length ? <p className="mt-4 text-sm text-[var(--fp-muted)]">Este crédito todavía no está disponible para aprobación. Actualiza el expediente para consultar su estado.</p> : null}
              {reviewChanged ? <label className="mt-4 flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" checked={rereviewed} disabled={busy || loadingDetail || Boolean(detailError)} onChange={(event) => setRereviewed(event.target.checked)} className="h-5 w-5 accent-[var(--fp-graphite)]" />Revisé de nuevo las fotografías y el documento actualizado.</label> : null}
              <div className="mt-5 flex flex-wrap gap-3"><Button onClick={requestApproval} disabled={!canConfirm}><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{saving ? "Confirmando..." : "OK para liquidación"}</Button><Button variant="secondary" disabled={busy || loadingDetail || searching} onClick={() => void loadDetail(detail.id)}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar expediente</Button></div>
            </Card>
          ) : null}
        </section>
      ) : null}

      </div>

      <ConfirmDialog open={Boolean(confirmation)} title="Aprobar para liquidación" description={confirmation ? `Confirma que revisaste el expediente de ${confirmation.clienteNombre}, cédula ${confirmation.clienteDocumento}, folio ${confirmation.folio}. Confirma que realizaste la llamada, guardaste su grabación y verificaste las correcciones. Tu aprobación habilitará este crédito para la liquidación al aliado y quedará registrada.` : ""} confirmLabel="Confirmar OK para liquidación" busy={saving} onCancel={() => { if (!saving && !submitting.current) setConfirmation(null); }} onConfirm={() => void confirmApproval()} />
    </main>
  );
}
