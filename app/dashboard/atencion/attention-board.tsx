"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, GripVertical, MessageCircle, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { Button, EmptyState, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import type { AttentionActor } from "@/lib/atencion-types";
import { attentionBoardColors, type AttentionBoard as BoardData, type AttentionBoardCard, type AttentionBoardCards, type AttentionBoardColor, type AttentionBoardSection, type AttentionBoardSectionMutation, type AttentionBoardMutationResult, type AttentionBoardMoveResult } from "@/lib/atencion-board-types";
import { AttentionConversationIndicators } from "./attention-operational";
import styles from "./attention-board.module.css";

type Props = { actor: AttentionActor; active?: boolean; onOpenConversation: (id: string) => void; onRefresh: number; onAccessDenied: (message: string) => void; busyChanged?: (busy: boolean) => void };
type Column = { cards: AttentionBoardCard[]; page: number; pageSize: number; total: number; loading: boolean; error: string };
type EditSection = { id: string; version: number; name: string; color: AttentionBoardColor; stale: boolean };
type WithoutRequest<T> = T extends { requestId: string } ? Omit<T, "requestId"> : never;
const colors: Record<AttentionBoardColor, string> = { green: "Verde", lime: "Lima", amber: "Ámbar", slate: "Grafito", navy: "Azul marino" };
const dragType = "application/x-finser-attention-card";
const keyOf = (id: string | null) => id ?? "none";
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "C";
const explanation = (error: unknown) => error instanceof Error ? error.message : "No fue posible actualizar el tablero.";
class BoardError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new BoardError(typeof body?.error === "string" ? body.error : "No fue posible actualizar el tablero.", response.status);
  return body as T;
}
function uniqueCards(cards: AttentionBoardCard[]) { return [...new Map(cards.map(card => [card.id, card])).values()]; }

export default function AttentionBoard({ actor, active = true, onOpenConversation, onRefresh, onAccessDenied, busyChanged }: Props) {
  const [storedBoard, setStoredBoard] = useState<{ actor: string; data: BoardData } | null>(null);
  const board = storedBoard?.actor === actor.key ? storedBoard.data : null;
  const [columns, setColumns] = useState<Record<string, Column>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<AttentionBoardColor>("slate");
  const [editing, setEditing] = useState<EditSection | null>(null);
  const [archive, setArchive] = useState<AttentionBoardSection | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const reads = useRef(new Map<string, AbortController>());
  const loadedPages = useRef<Record<string, number>>({});
  const lastSearch = useRef("");
  const busyRef = useRef(false);
  const blocked = useRef(false);
  const drag = useRef<{ id: string; sectionId: string | null; boardVersion: number } | null>(null);
  const intent = useRef<{ payload: string; requestId: string } | null>(null);
  const context = useRef({ active, actorKey: actor.key, onAccessDenied, busyChanged });
  context.current = { active, actorKey: actor.key, onAccessDenied, busyChanged };

  function stopReads() { ++generation.current; reads.current.forEach(controller => controller.abort()); reads.current.clear(); }
  function deny(error: unknown) {
    if (!(error instanceof BoardError) || ![401, 403].includes(error.status)) return false;
    stopReads(); blocked.current = true; drag.current = null;
    setStoredBoard(null); setColumns({}); setEditing(null); setManagerOpen(false); setArchive(null); setLoading(false); setReadError(explanation(error));
    context.current.onAccessDenied(explanation(error)); return true;
  }
  useEffect(() => {
    alive.current = true;
    const registry = reads.current;
    return () => { alive.current = false; registry.forEach(controller => controller.abort()); registry.clear(); };
  }, []);
  useEffect(() => {
    stopReads();
    const currentGeneration = generation.current;
    const owner = actor.key;
    if (!active || blocked.current) return;
    const controller = new AbortController(); reads.current.set("board", controller);
    const current = () => alive.current && context.current.active && context.current.actorKey === owner && !controller.signal.aborted && generation.current === currentGeneration;
    const timer = setTimeout(async () => {
      if (!current() || busyRef.current) return;
      if (lastSearch.current !== search) { loadedPages.current = {}; lastSearch.current = search; }
      setLoading(true); setReadError("");
      try {
        const next = await request<BoardData>(`/api/atencion/board?${new URLSearchParams({ search })}`, { signal: controller.signal });
        if (!current()) return;
        const sameOwner = storedBoard?.actor === owner;
        if (!sameOwner) loadedPages.current = {};
        setStoredBoard({ actor: owner, data: next });
        setColumns(previous => Object.fromEntries(next.sections.map(section => {
          const key = keyOf(section.id); const old = sameOwner ? previous[key] : undefined;
          return [key, { cards: old?.cards || [], page: old?.page || 1, pageSize: next.pageSize, total: section.count, loading: true, error: "" }];
        })));
        await Promise.all(next.sections.map(async section => {
          const key = keyOf(section.id);
          const pages = Math.min(loadedPages.current[key] || 1, Math.max(1, Math.ceil(section.count / next.pageSize)));
          try {
            const batches = await Promise.all(Array.from({ length: pages }, (_, index) => request<AttentionBoardCards>(`/api/atencion/board/cards?${new URLSearchParams({ sectionId: key, search, page: String(index + 1) })}`, { signal: controller.signal })));
            if (!current()) return;
            const first = batches[0];
            loadedPages.current[key] = pages;
            setColumns(previous => ({ ...previous, [key]: { cards: uniqueCards(batches.flatMap(batch => batch.conversations)), page: pages, pageSize: first.pageSize, total: first.total, loading: false, error: "" } }));
          } catch (error) {
            if (!current() || deny(error)) return;
            setColumns(previous => ({ ...previous, [key]: { ...(previous[key] || { cards: [], page: 1, pageSize: next.pageSize, total: section.count }), loading: false, error: explanation(error) } }));
          }
        }));
      } catch (error) { if (current() && !deny(error)) setReadError(explanation(error)); }
      finally { if (current()) setLoading(false); if (reads.current.get("board") === controller) reads.current.delete("board"); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
    // Every revision is a scoped read; a mutation bumps revision after releasing its lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, actor.key, onRefresh, revision, search]);

  function refresh() { if (!busyRef.current) { blocked.current = false; setRevision(value => value + 1); } }
  function requestId(url: string, input: unknown) {
    const payload = JSON.stringify({ url, input });
    if (intent.current?.payload !== payload) intent.current = { payload, requestId: crypto.randomUUID() };
    return intent.current.requestId;
  }
  function startMutation() {
    if (busyRef.current || !active) return false;
    stopReads(); busyRef.current = true; setBusy(true); setActionError(""); setNotice(""); drag.current = null; setDropTarget(null); context.current.busyChanged?.(true); return true;
  }
  function finishMutation() {
    busyRef.current = false; context.current.busyChanged?.(false);
    if (alive.current) { setBusy(false); if (!blocked.current) { setLoading(true); setRevision(value => value + 1); } }
  }
  async function move(card: AttentionBoardCard, sectionId: string | null) {
    const destination = board?.sections.find(section => section.id === sectionId);
    if (loading || !destination || card.sectionId === sectionId || !(actor.central || card.assigneeKey === actor.key) || !startMutation()) return;
    const url = `/api/atencion/${encodeURIComponent(card.id)}/section`;
    const input = { sectionId, boardVersion: card.boardVersion };
    const owner = actor.key;
    try {
      await request<AttentionBoardMoveResult>(url, { method: "POST", body: JSON.stringify({ ...input, requestId: requestId(url, input) }) });
      intent.current = null;
      if (alive.current && context.current.actorKey === owner) setNotice(`Conversación movida a ${destination.name}.`);
    } catch (error) {
      if (!alive.current || context.current.actorKey !== owner || deny(error)) return;
      if (error instanceof BoardError && error.status === 404) setColumns(previous => Object.fromEntries(Object.entries(previous).map(([key, column]) => [key, { ...column, cards: column.cards.filter(item => item.id !== card.id) }])));
      if (error instanceof BoardError && error.status === 409) intent.current = null;
      setActionError(error instanceof BoardError && error.status === 409 ? "El chat cambió de sección. Actualizamos el tablero; revisa su ubicación antes de volver a moverlo." : `${explanation(error)} Actualiza el tablero antes de intentar otro movimiento.`);
    } finally { finishMutation(); }
  }
  async function mutateSection(input: WithoutRequest<AttentionBoardSectionMutation>) {
    if (!actor.central || !board?.permissions.manage || loading || !startMutation()) return;
    const owner = actor.key;
    try {
      const result = await request<AttentionBoardMutationResult>("/api/atencion/board", { method: "PATCH", body: JSON.stringify({ ...input, requestId: requestId("/api/atencion/board", input) }) });
      intent.current = null;
      if (!alive.current || context.current.actorKey !== owner) return;
      if (input.action === "create") setNewName("");
      if (input.action === "archive") { setArchive(null); setEditing(value => value?.id === input.id ? null : value); }
      const saved = result.section;
      if (saved) setEditing(value => value && value.id === saved.id ? { ...value, version: saved.version, stale: false, ...(input.action === "rename" ? { name: saved.name } : {}), ...(input.action === "color" ? { color: saved.color } : {}) } : value);
      setNotice(input.action === "archive" ? "Sección archivada." : input.action === "reorder" ? "Orden de las secciones guardado." : "Sección guardada.");
    } catch (error) {
      if (!alive.current || context.current.actorKey !== owner || deny(error)) return;
      if (error instanceof BoardError && error.status === 409) { intent.current = null; setEditing(value => value ? { ...value, stale: true } : value); setArchive(null); }
      setActionError(error instanceof BoardError && error.status === 409 ? `La sección cambió. ${explanation(error)} Revisa los datos actualizados antes de continuar.` : explanation(error));
    } finally { finishMutation(); }
  }
  async function loadMore(section: AttentionBoardSection) {
    const key = keyOf(section.id); const column = columns[key];
    if (!active || busyRef.current || loading || !column || column.loading || column.cards.length >= column.total || reads.current.has(key)) return;
    const controller = new AbortController(); reads.current.set(key, controller);
    const currentGeneration = generation.current; const owner = actor.key; const page = column.page + 1;
    const current = () => alive.current && context.current.active && context.current.actorKey === owner && currentGeneration === generation.current && !controller.signal.aborted;
    setColumns(previous => ({ ...previous, [key]: { ...previous[key], loading: true, error: "" } }));
    try {
      const result = await request<AttentionBoardCards>(`/api/atencion/board/cards?${new URLSearchParams({ sectionId: key, search, page: String(page) })}`, { signal: controller.signal });
      if (!current()) return;
      loadedPages.current[key] = page;
      setColumns(previous => ({ ...previous, [key]: { cards: uniqueCards([...previous[key].cards, ...result.conversations]), page, pageSize: result.pageSize, total: result.total, loading: false, error: "" } }));
    } catch (error) { if (current() && !deny(error)) setColumns(previous => ({ ...previous, [key]: { ...previous[key], loading: false, error: explanation(error) } })); }
    finally { if (reads.current.get(key) === controller) reads.current.delete(key); }
  }
  const manageable = Boolean(actor.central && board?.permissions.manage);
  const sections = board?.sections || [];
  const custom = sections.filter((section): section is AttentionBoardSection & { id: string } => section.id !== null);
  function reorder(index: number, offset: number) {
    const ordered = [...custom]; const neighbor = index + offset;
    if (neighbor < 0 || neighbor >= ordered.length) return;
    [ordered[index], ordered[neighbor]] = [ordered[neighbor], ordered[index]];
    void mutateSection({ action: "reorder", ordered: ordered.map(section => ({ id: section.id, version: section.version })) });
  }

  return <section className={styles.board} aria-label="Tablero de conversaciones">
    <div className={styles.toolbar}><label className={styles.search}><Search aria-hidden="true" size={18} /><span className={styles.srOnly}>Buscar en el tablero</span><Input aria-label="Buscar en el tablero" placeholder="Buscar nombre o teléfono…" value={search} maxLength={100} disabled={busy} onChange={event => setSearch(event.target.value)} /></label><div className={styles.tools}><Button variant="ghost" onClick={refresh} disabled={busy} aria-label="Actualizar tablero" title="Actualizar tablero"><RefreshCw aria-hidden="true" size={18} /></Button>{manageable && <Button variant="secondary" disabled={busy} onClick={() => setManagerOpen(true)}><Settings2 aria-hidden="true" size={18} />Secciones</Button>}</div></div>
    <p className={styles.help}>Secciones manuales para organizar chats. La etiqueta automática FINSERPAY se conserva.</p>
    {(actionError || readError) && <div className={styles.error} role="alert"><span>{actionError || readError}</span><Button variant="secondary" disabled={busy} onClick={refresh}>Actualizar</Button></div>}
    {notice && <div className={styles.notice} role="status"><span>{notice}</span><Button variant="ghost" aria-label="Ocultar confirmación del tablero" onClick={() => setNotice("")}><X size={16} aria-hidden="true" /></Button></div>}
    {!board ? loading ? <LoadingState label="Consultando secciones…" /> : <EmptyState title="Tablero no disponible" description="Actualiza la vista para volver a consultar tus conversaciones." /> : <div className={styles.canvas} aria-label="Secciones del tablero" aria-busy={loading}>
      {sections.map(section => {
        const key = keyOf(section.id); const column = columns[key];
        return <section key={key} className={`${styles.column} ${dropTarget === key ? styles.dropTarget : ""}`} data-color={section.color} aria-label={`Sección ${section.name}`} onDragOver={event => { if (drag.current && !busy && !loading) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(key); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(value => value === key ? null : value); }} onDrop={event => {
          event.preventDefault(); const picked = drag.current; drag.current = null; setDropTarget(null);
          if (!picked || !Array.from(event.dataTransfer.types).includes(dragType)) return;
          const card = columns[keyOf(picked.sectionId)]?.cards.find(item => item.id === picked.id);
          if (!card || card.boardVersion !== picked.boardVersion) { setActionError("La conversación cambió mientras la movías. Actualiza el tablero y revisa su sección."); return; }
          void move(card, section.id);
        }}>
          <header className={styles.columnHeader}><span className={styles.colorDot} aria-hidden="true" /><h3>{section.name}</h3><span className={styles.count} aria-label={`${section.count} conversaciones`}>{section.count}</span></header>
          <div className={styles.columnScroll} tabIndex={0} aria-label={`Conversaciones de ${section.name}`}>
            {column?.error && <div className={styles.columnError} role="alert"><p>{column.error}</p><Button variant="secondary" disabled={busy} onClick={refresh}>Reintentar</Button></div>}
            {!column || column.loading && !column.cards.length ? <LoadingState label="Cargando chats…" /> : !column.cards.length ? <p className={styles.emptyColumn}>{search ? "Sin coincidencias" : "Sin conversaciones"}</p> : column.cards.map(card => {
              const movable = actor.central || card.assigneeKey === actor.key;
              return <article key={card.id} className={styles.card} draggable={movable && !busy && !loading} onDragStart={event => {
                if (!movable || busy || loading || (event.target as HTMLElement).closest("button,input,select,a")) { event.preventDefault(); return; }
                drag.current = { id: card.id, sectionId: card.sectionId, boardVersion: card.boardVersion }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(dragType, card.id);
              }} onDragEnd={() => { drag.current = null; setDropTarget(null); }}>
                <div className={styles.cardHeader}><span className={styles.avatar}>{initials(card.customerIdentity?.name || card.name)}</span><button type="button" className={styles.openCard} disabled={busy} onClick={() => onOpenConversation(card.id)}><strong>{card.customerIdentity?.name || card.name || card.phone || "Contacto de WhatsApp"}</strong>{card.customerIdentity && <span className={styles.document}>{card.customerIdentity.documentLabel || "Cédula"} {card.customerIdentity.document}</span>}<span>{card.phone || (card.channel === "internal" ? "Gestión interna" : "Teléfono no disponible")}</span></button>{movable && <GripVertical className={styles.grip} aria-hidden="true" size={17} />}</div>
                <p className={styles.preview}>{card.preview || "Abre el chat para consultar su historial"}</p>
                <div className={styles.cardMeta}><span title={card.assigneeName || "Sin asignar"}>{card.assigneeName || "Sin asignar"}</span>{card.autoTags?.includes("FINSERPAY") && <span className={styles.customerBadge} title="Etiqueta automática de cliente con crédito"><ShieldCheck size={12} aria-hidden="true" />FINSERPAY</span>}</div>
                <AttentionConversationIndicators conversation={card} />
                <div className={styles.cardActions}><Select aria-label={`Mover ${card.customerIdentity?.name || card.name || "conversación"} a otra sección`} value="" disabled={!movable || busy || loading} onChange={event => { const destination = sections.find(item => keyOf(item.id) === event.target.value); if (destination) void move(card, destination.id); }}><option value="">Mover a…</option>{sections.filter(item => item.id !== card.sectionId).map(item => <option key={keyOf(item.id)} value={keyOf(item.id)}>{item.name}</option>)}</Select><Button variant="ghost" aria-label={`Abrir chat de ${card.customerIdentity?.name || card.name || "contacto"}`} disabled={busy} onClick={() => onOpenConversation(card.id)}><MessageCircle size={18} aria-hidden="true" /></Button></div>
              </article>;
            })}
            {column && column.cards.length < column.total && <Button className={styles.loadMore} variant="secondary" disabled={busy || loading || column.loading} onClick={() => void loadMore(section)}>{column.loading ? "Cargando…" : `Cargar más · ${column.cards.length} de ${column.total}`}</Button>}
          </div>
        </section>;
      })}
    </div>}
    {manageable && <FinserSidePanel open={active && managerOpen} title="Secciones del tablero" closeLabel="Cerrar secciones" busy={busy} onClose={() => { setManagerOpen(false); setArchive(null); }}>
      <div className={styles.manager}><p>Los nombres y colores son compartidos. Puedes archivar una sección cuando no tenga conversaciones.</p>{actionError && <p className={styles.error} role="alert">{actionError}</p>}
        <form className={styles.createSection} onSubmit={event => { event.preventDefault(); if (newName.trim()) void mutateSection({ action: "create", name: newName.trim(), color: newColor }); }}><h3>Nueva sección</h3><label>Nombre<Input value={newName} required maxLength={60} disabled={busy} onChange={event => setNewName(event.target.value)} /></label><label>Color<Select value={newColor} disabled={busy} onChange={event => setNewColor(event.target.value as AttentionBoardColor)}>{attentionBoardColors.map(color => <option key={color} value={color}>{colors[color]}</option>)}</Select></label><Button type="submit" disabled={busy || loading || !newName.trim() || custom.length >= 20}><Plus size={17} aria-hidden="true" />Crear sección</Button>{custom.length >= 20 && <p className={styles.help}>Máximo 20 secciones. Puedes archivar una vacía para crear otra.</p>}</form>
        <ol className={styles.sectionList}>{custom.map((section, index) => <li key={section.id} data-color={section.color}><div className={styles.sectionTitle}><span className={styles.colorDot} aria-hidden="true" /><div><strong>{section.name}</strong><span>{section.totalCount} conversaciones</span></div></div><div className={styles.sectionActions}><Button variant="ghost" disabled={busy || loading || index === 0} aria-label={`Subir ${section.name}`} onClick={() => reorder(index, -1)}><ArrowUp size={17} /></Button><Button variant="ghost" disabled={busy || loading || index === custom.length - 1} aria-label={`Bajar ${section.name}`} onClick={() => reorder(index, 1)}><ArrowDown size={17} /></Button><Button variant="ghost" disabled={busy || loading} aria-label={`Editar ${section.name}`} onClick={() => setEditing({ id: section.id, version: section.version, name: section.name, color: section.color, stale: false })}><Pencil size={17} /></Button><Button variant="ghost" disabled={busy || loading || section.totalCount !== 0} aria-label={`Archivar ${section.name}`} title={section.totalCount ? "Solo se puede archivar una sección vacía" : "Archivar sección vacía"} onClick={() => setArchive(section)}><Archive size={17} /></Button></div>
          {editing?.id === section.id && <div className={styles.editSection}>{editing.stale && <div className={styles.reviewChange}><p>Nombre actual: {section.name}. Conservamos tu borrador; revisa los cambios antes de guardarlo.</p><Button variant="secondary" disabled={busy || loading} onClick={() => setEditing(value => value ? { ...value, version: section.version, stale: false } : value)}>Actualizar revisión</Button></div>}<label>Nombre<Input value={editing.name} maxLength={60} disabled={busy} onChange={event => setEditing(value => value ? { ...value, name: event.target.value } : value)} /></label><Button variant="secondary" disabled={busy || loading || editing.stale || !editing.name.trim() || editing.name.trim() === section.name} onClick={() => void mutateSection({ action: "rename", id: editing.id, version: editing.version, name: editing.name.trim() })}>Guardar nombre</Button><label>Color<Select value={editing.color} disabled={busy} onChange={event => setEditing(value => value ? { ...value, color: event.target.value as AttentionBoardColor } : value)}>{attentionBoardColors.map(color => <option key={color} value={color}>{colors[color]}</option>)}</Select></label><Button variant="secondary" disabled={busy || loading || editing.stale || editing.color === section.color} onClick={() => void mutateSection({ action: "color", id: editing.id, version: editing.version, color: editing.color })}>Aplicar color</Button></div>}
        </li>)}</ol><p className={styles.help}>«Sin sección» permanece disponible y no se puede archivar.</p>
        <ConfirmDialog open={active && Boolean(archive)} title="Archivar sección vacía" description={`Se archivará «${archive?.name || ""}». No se eliminarán chats ni se cambiará la etiqueta automática FINSERPAY.`} confirmLabel="Archivar sección" danger busy={busy} onCancel={() => setArchive(null)} onConfirm={() => { if (archive?.id && sections.find(section => section.id === archive.id)?.totalCount === 0) void mutateSection({ action: "archive", id: archive.id, version: archive.version }); else { setArchive(null); setActionError("La sección ya contiene conversaciones. Actualiza el tablero antes de continuar."); } }} />
      </div>
    </FinserSidePanel>}
  </section>;
}
