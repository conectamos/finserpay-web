"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Expand, FileText, ImageOff, RefreshCw, ShieldCheck } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { PAYMENT_FREQUENCY_OPTIONS } from "@/lib/credit-factory";
import LastPdfPagePreview from "./last-pdf-page-preview";
import ApprovalEvidenceCorrection from "./approval-evidence-correction";
import ApprovalSignatureReissue from "./approval-signature-reissue";
import ApprovalNoveltyPanel from "./approval-novelty-panel";
import { Badge, Button, Card, DataTable, EmptyState, LoadingState, MetricCard, PageHeader, StatusPill } from "@/app/_components/finser-ui";
import { ApprovalRequestError, approveCreditReview, readApprovalCredit, readApprovalQueue, mergeApprovalQueuePage, type ApprovalDetail, type ApprovalQueueItem, type ApprovalStatus } from "./approval-client";

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

type Confirmation = { id: number; folio: string; clienteNombre: string; clienteDocumento: string | null; revision: number; reviewHash: string };

export default function ApprovalConsole() {
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
  const busy = saving || Boolean(confirmation) || correctionBusy || signatureBusy || noveltyBusy;

  useEffect(() => () => {
    searchController.current?.abort();
    detailController.current?.abort();
  }, []);

  async function loadDetail(id: number) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setLoadingDetail(true);
    setDetailError("");
    try {
      const nextDetail = await readApprovalCredit(id, controller.signal);
      if (controller.signal.aborted) return;
      if (nextDetail.review.status === "APPROVED") {
        setItems((current) => current.filter((item) => item.id !== id)); setSelectedId(null); setDetail(null);
        setNotice({ text: `Crédito ${nextDetail.folio} aprobado. Ya no aparece entre los pendientes.`, warning: false });
        return nextDetail;
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
    await loadQueue();
    if (next && (next.review.revision !== detail.review.revision || next.review.reviewHash !== detail.review.reviewHash)) {
      setReviewChanged(true);
      setRereviewed(false);
      setNotice({ text: "El expediente se actualizó. Revisa las fotografías y la firma vigente antes de confirmar un nuevo OK.", warning: true });
    }
  }

  function selectCredit(id: number) {
    if (busy || submitting.current) return;
    setSelectedId(id);
    setDetail(null);
    setConfirmation(null);
    setNotice(null);
    setReviewChanged(false);
    setRereviewed(false);
    void loadDetail(id);
  }

  const loadQueue = useCallback(async (cursor: string | null = null) => {
    searchController.current?.abort();
    const controller = new AbortController(); searchController.current = controller;
    setSearching(true); setSearchError("");
    try {
      const page = await readApprovalQueue(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => mergeApprovalQueuePage(current, page.items, Boolean(cursor)));
      setNextCursor(page.nextCursor); setHasExtraPages(Boolean(cursor)); setQueueLoaded(true);
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "No fue posible cargar el muro.");
    } finally { if (!controller.signal.aborted) setSearching(false); }
  }, []);

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
        const page = await readApprovalQueue(null, controller.signal);
        const updated = selectedId ? await readApprovalCredit(selectedId, controller.signal) : null;
        if (controller.signal.aborted) return;
        setItems(page.items); setNextCursor(page.nextCursor); setSearchError("");
        if (updated) {
          if (updated.review.status === "APPROVED") {
            setSelectedId(null); setDetail(null);
            setNotice({ text: `Crédito ${updated.folio} aprobado. Ya no aparece entre los pendientes.`, warning: false });
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
  }, [busy, searching, loadingDetail, queueLoaded, hasExtraPages, selectedId, detail]);

  const canConfirm = Boolean(detail?.review.required && detail.review.status === "PENDING" && detail.canApprove && !loadingDetail && !detailError && !searchError && !searching && !busy && (!reviewChanged || rereviewed));

  function requestApproval() {
    if (!detail || !canConfirm || submitting.current) return;
    setNotice(null);
    setConfirmation({ id: detail.id, folio: detail.folio, clienteNombre: detail.clienteNombre, clienteDocumento: detail.clienteDocumento, revision: detail.review.revision, reviewHash: detail.review.reviewHash });
  }

  async function confirmApproval() {
    if (!confirmation || submitting.current || !detail || detail.id !== confirmation.id || detail.review.revision !== confirmation.revision || detail.review.reviewHash !== confirmation.reviewHash) return;
    submitting.current = true;
    setSaving(true);
    try {
      await approveCreditReview(confirmation.id, confirmation.revision, confirmation.reviewHash);
      setConfirmation(null);
      setNotice({ text: `Crédito ${confirmation.folio} aprobado para liquidación al aliado.`, warning: false });
      setItems((current) => current.filter((item) => item.id !== confirmation.id));
      detailController.current?.abort(); setSelectedId(null); setDetail(null); setLoadingDetail(false);
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

  return (
    <main className="space-y-6 p-4 text-[var(--fp-graphite)] sm:p-6 lg:p-8">
      <PageHeader eyebrow="Control documental" title="Muro de aprobaciones" description="Revisa los créditos pendientes de todos los aliados. Los aprobados salen de esta bandeja." actions={<Button variant="secondary" disabled={busy || searching} onClick={() => void loadQueue()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar muro</Button>} />
      <p className="text-sm text-[var(--fp-muted)]">Los créditos más antiguos aparecen primero. Las correcciones del aliado vuelven a revisión del analista.</p>
      {searchError ? <div role="alert" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-amber-soft)] p-4 text-sm">{searchError} Actualiza el muro para continuar.</div> : null}
      {searching ? <LoadingState label="Cargando créditos pendientes..." /> : null}
      {queueLoaded && !items.length && !searching && !searchError ? <Card><EmptyState title="No hay créditos pendientes" description="Los nuevos créditos y los expedientes que requieran otra revisión aparecerán aquí." /></Card> : null}
      {items.length ? (
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--fp-border)] p-4 sm:px-6"><h2 className="font-semibold">Créditos por revisar</h2><p className="mt-1 text-sm text-[var(--fp-muted)]">{items.length} {items.length === 1 ? "crédito visible" : "créditos visibles"}{nextCursor ? " · Hay más pendientes" : ""}</p></div>
          <DataTable className="max-w-full">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <thead className="bg-[var(--fp-bg)] text-[var(--fp-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Folio / cliente</th>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Aliado</th>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Fecha del crédito</th>
                  <th scope="col" className="px-4 py-3 font-semibold sm:px-6">Revisión</th>
                  <th scope="col" className="relative px-4 py-3 sm:px-6"><span className="sr-only">Seleccionar crédito</span></th>
                </tr>
              </thead>
              <tbody>{items.map((item) => (
                <tr key={item.id} className={`border-t border-[var(--fp-border)] ${selectedId === item.id ? "bg-[var(--fp-lime-soft)]" : ""}`}>
                  <td className="px-4 py-4 align-top sm:px-6"><strong>{item.folio}</strong><span className="mt-1 block text-[var(--fp-muted)]">{item.clienteNombre}</span></td>
                  <td className="px-4 py-4 align-top sm:px-6">{item.aliadoNombre}{item.sedeNombre ? <span className="mt-1 block text-[var(--fp-muted)]">{item.sedeNombre}</span> : null}</td>
                  <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">{dateLabel(item.fechaCredito)}</td>
                  <td className="px-4 py-4 align-top sm:px-6"><div className="flex flex-col items-start gap-2"><ReviewStatus status={item.status} required={item.required} />
                    {item.novelty?.pendingCount ? <Badge tone="warning">{item.novelty.pendingCount} por corregir en el aliado</Badge> : null}
                    {item.novelty?.answeredCount ? <Badge tone="positive">Correcciones por revisar</Badge> : null}
                    {item.reissue?.blocked ? <Badge tone="warning">Firma pendiente</Badge> : null}
                  </div></td>
                  <td className="px-4 py-4 align-top sm:px-6"><Button variant="secondary" onClick={() => selectCredit(item.id)} disabled={busy || searching} aria-label={`Revisar crédito ${item.folio}`} aria-pressed={selectedId === item.id}>{selectedId === item.id ? "Seleccionado" : "Revisar"}</Button></td>
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
              {[["Cédula", detail.clienteDocumento], ["Correo", detail.clienteCorreo], ["Teléfono", detail.clienteTelefono]].map(([label, value]) => (
                <div key={label} className="min-w-0"><dt className="text-[var(--fp-muted)]">{label}</dt><dd className="mt-1 break-words font-medium">{value?.trim() || "No disponible"}</dd></div>
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
            <ApprovalEvidenceCorrection detail={detail} disabled={saving || Boolean(confirmation) || signatureBusy || noveltyBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setCorrectionBusy} />
          </Card>

          <div className={`grid items-start gap-6 ${detail.review.required ? "xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]" : ""}`}>
            <Card role="region" aria-label="Documento firmado" className="min-w-0 p-4 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5" aria-hidden="true" />Documento firmado</h2></div>
              {detail.document.available ? <><p className="mb-3 break-words text-sm text-[var(--fp-muted)]">{detail.document.fileName || "Documento de FirmaSeguro"}</p><LastPdfPagePreview key={`${detail.id}:${detail.review.reviewHash}`} href={detail.document.href} folio={detail.folio} /></> : <EmptyState title="Documento firmado no disponible" description="El expediente debe contar con el documento firmado para completar la aprobación." />}
            </Card>

            {detail.review.required ? <aside aria-label="Acciones de revisión" className="min-w-0 space-y-6">
              <ApprovalNoveltyPanel key={detail.id} detail={detail} disabled={saving || Boolean(confirmation) || correctionBusy || signatureBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setNoveltyBusy} />
              <ApprovalSignatureReissue detail={detail} disabled={saving || Boolean(confirmation) || correctionBusy || noveltyBusy || loadingDetail || searching || Boolean(detailError)} onUpdated={reloadAfterCorrection} onBusyChange={setSignatureBusy} />
            </aside> : null}
          </div>

          {detail.review.required && detail.review.status === "PENDING" ? (
            <Card className="p-4 sm:p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5" aria-hidden="true" />OK para liquidación</h2>
              <p className="mt-2 text-sm text-[var(--fp-muted)]">Confirma después de revisar los datos financieros, las fotografías y el documento firmado.</p>
              {detail.blockingReasons.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-[var(--fp-danger)]">{detail.blockingReasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul> : null}
              {!detail.canApprove && !detail.blockingReasons.length ? <p className="mt-4 text-sm text-[var(--fp-muted)]">Este crédito todavía no está disponible para aprobación. Actualiza el expediente para consultar su estado.</p> : null}
              {reviewChanged ? <label className="mt-4 flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" checked={rereviewed} disabled={busy || loadingDetail || Boolean(detailError)} onChange={(event) => setRereviewed(event.target.checked)} className="h-5 w-5 accent-[var(--fp-graphite)]" />Revisé de nuevo las fotografías y el documento actualizado.</label> : null}
              <div className="mt-5 flex flex-wrap gap-3"><Button onClick={requestApproval} disabled={!canConfirm}><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{saving ? "Confirmando..." : "OK para liquidación"}</Button><Button variant="secondary" disabled={busy || loadingDetail || searching} onClick={() => void loadDetail(detail.id)}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar expediente</Button></div>
            </Card>
          ) : null}
        </section>
      ) : null}

      <ConfirmDialog open={Boolean(confirmation)} title="Aprobar para liquidación" description={confirmation ? `Confirma que revisaste el expediente de ${confirmation.clienteNombre}, cédula ${confirmation.clienteDocumento}, folio ${confirmation.folio}. Tu aprobación habilitará este crédito para la liquidación al aliado y quedará registrada.` : ""} confirmLabel="Confirmar OK para liquidación" busy={saving} onCancel={() => { if (!saving && !submitting.current) setConfirmation(null); }} onConfirm={() => void confirmApproval()} />
    </main>
  );
}
