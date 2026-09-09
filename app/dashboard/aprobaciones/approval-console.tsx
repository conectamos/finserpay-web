"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Expand, FileText, ImageOff, RefreshCw, Search, ShieldCheck } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import LastPdfPagePreview from "./last-pdf-page-preview";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, MetricCard, PageHeader, StatusPill } from "@/app/_components/finser-ui";
import { ApprovalRequestError, approveCreditReview, readApprovalCredit, searchApprovalCredits, type ApprovalDetail, type ApprovalListItem, type ApprovalStatus } from "./approval-client";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });

function dateLabel(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dates.format(date) : "No disponible";
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
  const [documentInput, setDocumentInput] = useState("");
  const [searchedDocument, setSearchedDocument] = useState("");
  const [items, setItems] = useState<ApprovalListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<{ text: string; warning: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [rereviewed, setRereviewed] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const busy = saving || Boolean(confirmation);

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
      setDetail(nextDetail);
      setItems((current) => current.map((item) => item.id === id ? { ...item, status: nextDetail.review.status, required: nextDetail.review.required } : item));
    } catch (error) {
      if (controller.signal.aborted) return;
      setDetailError(error instanceof Error ? error.message : "No fue posible cargar el expediente.");
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
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

  async function searchCredits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitting.current) return;
    const document = documentInput.replace(/[.\s-]/g, "");
    if (!/^\d{3,13}$/.test(document)) {
      setSearchError("Ingresa la cédula completa, entre 3 y 13 dígitos.");
      return;
    }
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setSearchError("");
    try {
      const nextItems = await searchApprovalCredits(document, controller.signal);
      if (controller.signal.aborted) return;
      detailController.current?.abort();
      setLoadingDetail(false);
      setItems(nextItems);
      setSearchedDocument(document);
      setSelectedId(null);
      setDetail(null);
      setDetailError("");
      setNotice(null);
      setReviewChanged(false);
      setRereviewed(false);
      if (nextItems.length === 1) selectCredit(nextItems[0].id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSearchError(error instanceof Error ? error.message : "No fue posible buscar los créditos.");
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  const canConfirm = Boolean(detail?.review.required && detail.review.status === "PENDING" && detail.canApprove && !loadingDetail && !detailError && !searching && !busy && (!reviewChanged || rereviewed));

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
      await loadDetail(confirmation.id);
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
      <PageHeader eyebrow="Control documental" title="Aprobaciones" description="Consulta por cédula, revisa el expediente y confirma el OK para liquidación al aliado." />
      <Card className="p-4 sm:p-6">
        <form onSubmit={searchCredits} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full sm:max-w-md">
            <label htmlFor="approval-document" className="mb-2 block text-sm font-semibold">Cédula del cliente</label>
            <Input id="approval-document" name="documento" inputMode="numeric" autoComplete="off" maxLength={20} value={documentInput} placeholder="Ingresa la cédula completa" disabled={busy} onChange={(event) => setDocumentInput(event.target.value)} aria-describedby="approval-search-help" />
          </div>
          <Button type="submit" disabled={busy || searching}><Search className="h-4 w-4" aria-hidden="true" />{searching ? "Buscando..." : "Buscar crédito"}</Button>
        </form>
        <p id="approval-search-help" className="mt-3 text-sm text-[var(--fp-muted)]">La búsqueda es exacta. Si hay varios folios, selecciona el crédito que vas a revisar.</p>
        {searchError ? <p role="alert" className="mt-4 text-sm text-[var(--fp-danger)]">{searchError}{items.length ? " Se conserva la consulta anterior." : ""}</p> : null}
      </Card>

      {searching ? <LoadingState label="Buscando créditos por cédula..." /> : null}
      {!searchedDocument && !searching ? <EmptyState title="Busca un cliente para comenzar" description="Aquí podrás consultar su resumen financiero, las cinco fotos y el documento firmado." /> : null}
      {searchedDocument && !items.length && !searching ? <Card><EmptyState title="No se encontraron créditos" description={`No hay créditos para la cédula ${searchedDocument}. Verifica el número e intenta otra búsqueda.`} /></Card> : null}
      {items.length ? (
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--fp-border)] p-4 sm:px-6"><h2 className="font-semibold">Créditos de la cédula {searchedDocument}</h2><p className="mt-1 text-sm text-[var(--fp-muted)]">{items.length} {items.length === 1 ? "folio encontrado" : "folios encontrados"}</p></div>
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
                  <td className="px-4 py-4 align-top sm:px-6">{item.aliadoNombre}</td>
                  <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">{dateLabel(item.fechaCredito)}</td>
                  <td className="px-4 py-4 align-top sm:px-6"><ReviewStatus status={item.status} required={item.required} /></td>
                  <td className="px-4 py-4 align-top sm:px-6"><Button variant="secondary" onClick={() => selectCredit(item.id)} disabled={busy || searching} aria-label={`Revisar crédito ${item.folio}`} aria-pressed={selectedId === item.id}>{selectedId === item.id ? "Seleccionado" : "Revisar"}</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </DataTable>
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
              <div><p className="text-sm text-[var(--fp-muted)]">Crédito {detail.folio}</p><h2 className="mt-1 text-xl font-bold">{detail.clienteNombre}</h2><p className="mt-2 text-sm text-[var(--fp-muted)]">Cédula {detail.clienteDocumento} · {detail.aliadoNombre}</p><p className="mt-1 text-sm text-[var(--fp-muted)]">{dateLabel(detail.fechaCredito)}</p></div>
              <ReviewStatus status={detail.review.status} required={detail.review.required} />
            </div>
            {detail.review.status === "APPROVED" ? <p className="mt-4 flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />Aprobado por {detail.review.approvedByName || "analista autorizado"} · {dateLabel(detail.review.approvedAt)}</p> : null}
            {!detail.review.required ? <p className="mt-4 text-sm text-[var(--fp-muted)]">Este crédito no está sujeto a la nueva revisión para liquidación.</p> : null}
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Score" value={detail.score ?? detail.scoreLabel ?? "No disponible"} detail="Registrado al evaluar el crédito" />
            <MetricCard label="Inicial aplicada" value={money.format(detail.cuotaInicial)} detail={detail.initialPaymentPercentage === null ? "Porcentaje aprobado en la oferta no disponible" : `${percent.format(detail.initialPaymentPercentage)} % aprobado en la oferta`} />
            <MetricCard label="Crédito autorizado" value={money.format(detail.creditoAutorizado)} detail={`Valor de venta: ${money.format(detail.valorVenta)}`} />
            <MetricCard label="Cupo aprobado" value={detail.approvedLimit === null ? "No disponible" : money.format(detail.approvedLimit)} detail="Cupo registrado en la evaluación" />
          </div>

          <Card className="p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Fotografías del expediente</h2><Badge>{detail.evidence.filter((item) => item.available).length} de {detail.evidence.length} disponibles</Badge></div>
            <p className="mb-4 text-sm text-[var(--fp-muted)]">Abre cada fotografía para revisarla en tamaño completo.</p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{detail.evidence.map((item) => <EvidencePhoto key={`${detail.id}:${detail.review.reviewHash}:${item.key}`} item={item} clientName={detail.clienteNombre} />)}</div>
          </Card>

          <Card className="p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5" aria-hidden="true" />Documento firmado</h2></div>
            {detail.document.available ? <><p className="mb-3 text-sm text-[var(--fp-muted)]">{detail.document.fileName || "Documento de FirmaSeguro"}</p><LastPdfPagePreview key={`${detail.id}:${detail.review.reviewHash}`} href={detail.document.href} folio={detail.folio} /></> : <EmptyState title="Documento firmado no disponible" description="El expediente debe contar con el documento firmado para completar la aprobación." />}
          </Card>

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
