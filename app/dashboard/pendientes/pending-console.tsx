"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Badge, Button, Card, DataTable, EmptyState, LoadingState, PageHeader, Select, StatusPill } from "@/app/_components/finser-ui";
import PendingItemEditor from "./pending-item-editor";
import { listPendingCredits, readPendingCredit, type PendingCredit, type PendingDetail, type PendingStatus } from "./pending-client";

function NoveltyStatus({ item }: { item: PendingCredit }) {
  return <StatusPill tone={item.novelty.status === "WAITING_ALLY" ? "warning" : "neutral"}>
    {item.novelty.status === "WAITING_ALLY" ? "Por corregir" : "Pendiente revisión analista"}
  </StatusPill>;
}

export default function PendingConsole() {
  const [items, setItems] = useState<PendingCredit[]>([]);
  const [filter, setFilter] = useState<PendingStatus | "ALL">("ALL");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PendingDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const busy = Boolean(editingId) || loadingDetail || loadingList;

  const loadList = useCallback(async (status: PendingStatus | "ALL", cursor?: string) => {
    listController.current?.abort();
    const controller = new AbortController(); listController.current = controller;
    setLoadingList(true); setLoadingMore(Boolean(cursor)); setListError("");
    try {
      const page = await listPendingCredits({ status: status === "ALL" ? undefined : status, cursor }, controller.signal);
      if (controller.signal.aborted) return false;
      setItems((previous) => cursor
        ? [...previous.filter((item) => !page.items.some((next) => next.id === item.id)), ...page.items]
        : page.items);
      setNextCursor(page.hasMore ? page.nextCursor : null);
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) setListError(failure instanceof Error ? failure.message : "No fue posible cargar los pendientes.");
      return false;
    } finally {
      if (!controller.signal.aborted) { setLoadingList(false); setLoadingMore(false); }
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    setLoadingDetail(true); setDetailError("");
    try {
      const next = await readPendingCredit(id, controller.signal);
      if (controller.signal.aborted) return false;
      setDetail(next);
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) setDetailError(failure instanceof Error ? failure.message : "No fue posible actualizar las novedades.");
      return false;
    } finally { if (!controller.signal.aborted) setLoadingDetail(false); }
  }, []);

  useEffect(() => {
    void loadList("ALL");
    return () => { listController.current?.abort(); detailController.current?.abort(); };
  }, [loadList]);

  useEffect(() => { if (detail?.id) detailHeading.current?.focus(); }, [detail?.id]);

  const handleBusyChange = useCallback((id: string, active: boolean) => {
    setEditingId((current) => active ? id : current === id ? null : current);
  }, []);

  async function afterResponse(message?: string) {
    if (message) setNotice(message);
    if (!selectedId) return;
    const [loaded] = await Promise.all([loadDetail(selectedId), loadList(filter)]);
    if (!loaded) throw new Error("No se pudo comprobar el estado actualizado.");
  }

  function selectCredit(id: number) {
    if (busy) return;
    setSelectedId(id); setDetail(null); setDetailError(""); setNotice("");
    void loadDetail(id);
  }

  function changeFilter(status: PendingStatus | "ALL") {
    if (busy) return;
    detailController.current?.abort();
    setFilter(status); setItems([]); setNextCursor(null); setSelectedId(null); setDetail(null); setDetailError(""); setNotice("");
    void loadList(status);
  }

  return <main className="min-w-0 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <PageHeader eyebrow="Administrador aliado" title="PENDIENTES"
      description="Corrige las novedades de tus créditos. Al guardar, cada respuesta vuelve automáticamente a revisión del analista."
      actions={<Button variant="secondary" disabled={busy} onClick={() => { void afterResponse().catch(() => undefined); if (!selectedId) void loadList(filter); }}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar
      </Button>} />
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-4 p-4 sm:p-5">
        <div><h2 className="text-base font-bold">Créditos con novedades</h2><p className="mt-1 text-sm text-[var(--fp-muted)]">Los créditos aprobados dejan de aparecer aquí.</p></div>
        <label className="flex min-w-0 flex-col gap-2 text-sm">Estado
          <Select aria-label="Filtrar pendientes por estado" value={filter} disabled={busy} onChange={(event) => changeFilter(event.target.value as PendingStatus | "ALL")}>
            <option value="ALL">Todas las novedades</option><option value="WAITING_ALLY">Por corregir</option><option value="RESPONDED">Pendiente revisión analista</option>
          </Select>
        </label>
      </div>
      {listError ? <div className="space-y-3 border-t border-[var(--fp-border)] p-4"><p className="text-sm text-[var(--fp-danger)]" role="alert">{listError}</p><Button variant="secondary" disabled={busy} onClick={() => { void loadList(filter); }}>Reintentar listado</Button></div> : null}
      {loadingList && !items.length ? <LoadingState label="Cargando créditos con novedades..." /> : !items.length && !listError ? <EmptyState
        title={filter === "ALL" ? "No tienes créditos con novedades" : "No hay créditos en este estado"}
        description={filter === "ALL" ? "Las novedades que señale el analista aparecerán en esta sección." : "Cambia el filtro para consultar los demás pendientes."} /> : items.length ? <>
        <DataTable><table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="bg-[var(--fp-bg)]"><tr className="border-y border-[var(--fp-border)]">
            <th scope="col" className="px-4 py-3 font-semibold">Crédito</th><th scope="col" className="px-4 py-3 font-semibold">Cliente</th>
            <th scope="col" className="px-4 py-3 font-semibold">Sede</th><th scope="col" className="px-4 py-3 font-semibold">Novedades</th>
            <th scope="col" className="px-4 py-3 font-semibold">Estado</th><th scope="col" className="relative px-4 py-3"><span className="sr-only">Abrir crédito</span></th>
          </tr></thead>
          <tbody>{items.map((item) => <tr key={item.id} className={`border-b border-[var(--fp-border)] last:border-0 ${selectedId === item.id ? "bg-[var(--fp-lime-soft)]" : ""}`}>
            <td className="px-4 py-4 font-semibold">{item.folio}</td><td className="px-4 py-4"><span className="block font-semibold">{item.clienteNombre}</span><span className="text-[var(--fp-muted)]">{item.clienteDocumento || "Sin documento"}</span></td>
            <td className="px-4 py-4">{item.sedeNombre}</td><td className="px-4 py-4"><span className="block">{item.novelty.pendingCount} por corregir</span><span className="text-[var(--fp-muted)]">{item.novelty.answeredCount} en revisión</span></td>
            <td className="px-4 py-4"><NoveltyStatus item={item} /></td><td className="px-4 py-4"><Button variant="secondary" disabled={busy} aria-label={`Ver novedades del crédito ${item.folio}`} onClick={() => selectCredit(item.id)}>Ver novedades<ChevronRight className="h-4 w-4" aria-hidden="true" /></Button></td>
          </tr>)}</tbody>
        </table></DataTable>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--fp-border)] p-4 text-sm text-[var(--fp-muted)]">
          <span>{items.length} {items.length === 1 ? "crédito cargado" : "créditos cargados"}{nextCursor ? " · Hay más resultados" : ""}</span>
          {nextCursor ? <Button variant="secondary" disabled={busy} onClick={() => { void loadList(filter, nextCursor); }}>{loadingMore ? "Cargando..." : "Cargar más créditos"}</Button> : null}
        </div>
      </> : null}
    </Card>
    {notice ? <div role="status" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] p-4 text-sm">{notice}</div> : null}
    {selectedId !== null ? <Card className="min-w-0 overflow-hidden p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div>
        <h2 ref={detailHeading} tabIndex={-1} className="text-xl font-bold outline-none">{detail ? `Novedades · ${detail.folio}` : "Novedades del crédito"}</h2>
        {detail ? <p className="mt-1 text-sm text-[var(--fp-muted)]">{detail.clienteNombre} · {detail.clienteDocumento || "Sin documento"} · {detail.sedeNombre}</p> : null}
      </div>{detail ? <NoveltyStatus item={detail} /> : null}</div>
      {detailError ? <div className="mb-5 space-y-3"><p role="alert" className="text-sm text-[var(--fp-danger)]">{detailError} Actualiza el crédito antes de corregir otra novedad.</p><Button variant="secondary" disabled={Boolean(editingId) || loadingDetail} onClick={() => { void loadDetail(selectedId); }}>Actualizar crédito</Button></div> : null}
      {loadingDetail ? <LoadingState label="Actualizando novedades del crédito..." /> : null}
      {detail ? <>
        <div className="mb-5 flex flex-wrap items-center gap-2"><Badge tone="warning">{detail.novelty.pendingCount} por corregir</Badge><Badge>{detail.novelty.answeredCount} en revisión</Badge></div>
        {!detail.canRespond && detail.blockedReason ? <p className="mb-5 text-sm text-[var(--fp-muted)]">{detail.blockedReason}</p> : null}
        <div>{detail.novelty.items.map((issue) => <PendingItemEditor key={`${detail.novelty.id}:${issue.id}:${issue.version}:${issue.status}`}
          detail={detail} issue={issue} disabled={Boolean(detailError) || loadingDetail || loadingList || (Boolean(editingId) && editingId !== issue.id)}
          onUpdated={afterResponse} onBusyChange={handleBusyChange} />)}</div>
      </> : null}
    </Card> : <EmptyState title="Selecciona un crédito" description="Abre sus novedades para ver el motivo y corregir únicamente lo solicitado por el analista." />}
  </main>;
}
