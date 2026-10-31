"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
import { attentionPhoneTextParts } from "@/lib/atencion-phone-links";
import styles from "./attention-message-text.module.css";

export type AttentionPhoneMatch = { id: string; name: string | null; phone: string; status?: string };
export type AttentionPhoneLookup = { matches: AttentionPhoneMatch[]; total: number };
export type AttentionPhoneLookupResult = AttentionPhoneLookup;
type ClosePopup = (restoreFocus?: boolean) => void;
type OpenPhone = { phone: string; index: number; text: string; contextKey?: string };
let closeActivePopup: ClosePopup | null = null;

export default function AttentionMessageText({ text, onOpenPhone, onOpenConversation, disabled = false, contextKey }: {
  text: string;
  onOpenPhone?: (phone: string, signal?: AbortSignal) => Promise<AttentionPhoneLookup>;
  onOpenConversation?: (id: string) => void;
  disabled?: boolean;
  contextKey?: string;
}) {
  const id = useId();
  const [selected, setSelected] = useState<OpenPhone | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 320, maxHeight: 420 });
  const [phase, setPhase] = useState<"idle" | "loading" | "results" | "error">("idle");
  const [result, setResult] = useState<AttentionPhoneLookup | null>(null);
  const [error, setError] = useState("");
  const anchor = useRef<HTMLButtonElement | null>(null), popup = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0), pending = useRef(false), opened = useRef<typeof selected>(null), alive = useRef(true);
  const lookupController = useRef<AbortController | null>(null);
  const live = useRef({ text, contextKey, disabled, onOpenPhone, onOpenConversation });
  live.current = { text, contextKey, disabled, onOpenPhone, onOpenConversation };

  const close: ClosePopup = useCallback((restoreFocus = true): void => {
    generation.current++;
    lookupController.current?.abort();
    lookupController.current = null;
    pending.current = false;
    opened.current = null;
    if (closeActivePopup === close) closeActivePopup = null;
    setSelected(null);
    setResult(null);
    setPhase("idle");
    setError("");
    if (restoreFocus && anchor.current?.isConnected) anchor.current.focus();
  }, []);

  useEffect(() => { close(false); }, [text, contextKey, disabled, close]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pending.current = false; lookupController.current?.abort(); lookupController.current = null; if (closeActivePopup === close) closeActivePopup = null; };
  }, [close]);

  useEffect(() => {
    if (!selected) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !popup.current?.contains(target) && !anchor.current?.contains(target)) close(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    const moved = (event: Event) => {
      const target = event.target as Node | null;
      if (event.type === "scroll" && target?.nodeType && popup.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    window.visualViewport?.addEventListener("resize", moved);
    window.visualViewport?.addEventListener("scroll", moved);
    popup.current?.querySelector<HTMLButtonElement>("[data-phone-lookup]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
      window.visualViewport?.removeEventListener("resize", moved);
      window.visualViewport?.removeEventListener("scroll", moved);
    };
  }, [selected, close]);

  useEffect(() => {
    if (!selected || !anchor.current) return;
    const viewport = window.visualViewport, margin = 12;
    const width = Math.max(0, Math.min(320, (viewport?.width ?? window.innerWidth) - margin * 2));
    const maxHeight = Math.max(0, Math.min(420, (viewport?.height ?? window.innerHeight) - margin * 2));
    const leftEdge = viewport?.offsetLeft ?? 0, topEdge = viewport?.offsetTop ?? 0;
    const right = leftEdge + (viewport?.width ?? window.innerWidth), bottom = topEdge + (viewport?.height ?? window.innerHeight);
    const rect = anchor.current.getBoundingClientRect(), height = Math.min(popup.current?.getBoundingClientRect().height || 180, maxHeight);
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const below = rect.bottom + 8;
    setPosition({ width, maxHeight, left: clamp(rect.left, leftEdge + margin, right - width - margin), top: clamp(below + height <= bottom - margin ? below : rect.top - height - 8, topEdge + margin, bottom - height - margin) });
    if (phase === "results" && result?.matches.length) popup.current?.querySelector<HTMLButtonElement>("[data-phone-choice]")?.focus();
  }, [selected, phase, result]);

  function open(phone: string, index: number, element: HTMLButtonElement) {
    if (live.current.disabled || !live.current.onOpenPhone || !live.current.onOpenConversation) return;
    if (opened.current?.index === index) { close(); return; }
    closeActivePopup?.(false);
    generation.current++;
    pending.current = false;
    anchor.current = element;
    opened.current = { phone, index, text: live.current.text, contextKey: live.current.contextKey };
    closeActivePopup = close;
    setResult(null); setPhase("idle"); setError("");
    setSelected(opened.current);
  }

  async function lookup() {
    const current = opened.current, callback = live.current.onOpenPhone;
    if (!current || !callback || live.current.disabled || pending.current) return;
    const request = ++generation.current, binding = live.current, controller = new AbortController();
    lookupController.current = controller;
    pending.current = true; setPhase("loading"); setError("");
    const valid = () => alive.current && !controller.signal.aborted && request === generation.current && !live.current.disabled && live.current.contextKey === binding.contextKey && live.current.text === binding.text;
    try {
      const found = await callback(current.phone, controller.signal);
      if (!valid()) return;
      const limited = { matches: found.matches.slice(0, 10), total: found.total };
      if (limited.total === 1 && limited.matches.length === 1) {
        live.current.onOpenConversation?.(limited.matches[0].id);
        close(false);
      } else { setResult(limited); setPhase("results"); }
    } catch (failure) {
      if (valid()) { setError(failure instanceof Error ? failure.message : "No se pudo consultar el chat. Vuelve a intentarlo."); setPhase("error"); }
    } finally { if (request === generation.current) pending.current = false; if (lookupController.current === controller) lookupController.current = null; }
  }

  function choose(match: AttentionPhoneMatch) {
    if (!opened.current || pending.current || live.current.disabled || opened.current.text !== live.current.text || opened.current.contextKey !== live.current.contextKey) return;
    live.current.onOpenConversation?.(match.id);
    close(false);
  }

  return <>
    <span className={styles.text}>{attentionPhoneTextParts(text).map((part, index) => part.phone && onOpenPhone && onOpenConversation ? <button type="button" key={index} className={styles.phone} disabled={disabled} aria-label={`Opciones para ${part.phone}`} aria-haspopup="dialog" aria-controls={selected?.index === index ? id : undefined} aria-expanded={selected?.index === index} onClick={event => open(part.phone!, index, event.currentTarget)}>{part.text}</button> : part.text)}</span>
    {selected && !disabled && createPortal(<div ref={popup} id={id} className={styles.popover} role="dialog" aria-label={`Opciones para ${selected.phone}`} data-chat-theme="dark" style={position}>
      <header><strong>{selected.phone}</strong><button type="button" className={styles.close} aria-label="Cerrar opciones del teléfono" onClick={() => close()}><X aria-hidden="true" size={18}/></button></header>
      {(phase === "idle" || phase === "loading" || phase === "error") && <Button type="button" data-phone-lookup className={styles.openAction} disabled={phase === "loading"} onClick={() => void lookup()}>{phase === "loading" ? "Buscando chat…" : "Abrir chat"}</Button>}
      {phase === "loading" && <p className={styles.muted} role="status">Consultando conversaciones disponibles…</p>}
      {phase === "error" && <p className={styles.error} role="alert">{error}</p>}
      {phase === "results" && result && (result.matches.length ? <>
        <p className={styles.muted}>Selecciona la conversación que quieres abrir.</p>
        <div className={styles.matches}>{result.matches.map(match => <button type="button" key={match.id} data-phone-choice onClick={() => choose(match)}><strong>{match.name || match.phone}</strong><span>{match.phone}{match.status ? ` · ${({ pending: "Pendiente", open: "En atención", closed: "Finalizada" } as Record<string,string>)[match.status] || match.status}` : ""}</span></button>)}</div>
        {result.total > 10 && <p className={styles.muted}>Hay {result.total} conversaciones. Se muestran las primeras 10; usa el buscador de la bandeja para acotar la lista.</p>}
      </> : <><p className={styles.muted} role="status">No hay un chat disponible para este número.</p><a className={styles.external} href={`https://wa.me/${selected.phone.replace(/\D/g, "")}`} target="_blank" rel="noopener noreferrer">Abrir en WhatsApp</a></>)}
    </div>, document.body)}
  </>;
}
