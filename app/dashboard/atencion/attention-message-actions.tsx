"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Forward, Reply, Sticker, X } from "lucide-react";
import type { AttentionMessage } from "@/lib/atencion-types";
import styles from "./attention-message-actions.module.css";

export type AttentionQuote = {
  id: string | null; author: string | null; text: string;
  attachment?: { kind: NonNullable<AttentionMessage["attachment"]>["kind"]; fileName: string | null };
};
export function attentionMessageSummary(message: Pick<AttentionMessage, "text" | "attachment"> | AttentionQuote) {
  const kind = message.attachment?.kind;
  const attachment = kind ? message.attachment?.fileName || ({ image: "Imagen", video: "Video", audio: "Audio", document: "Documento", sticker: "Sticker" }[kind]) : "";
  return [attachment, message.text].filter(Boolean).join(" · ") || "Mensaje";
}

export function AttentionQuotedMessage({ quote, onOpen }: { quote: AttentionQuote; onOpen?: () => void }) {
  const content = <><strong>{quote.author || "Mensaje anterior"}</strong><span>{attentionMessageSummary(quote)}</span></>;
  return onOpen && quote.id ? <button type="button" data-attention="message-quote" className={styles.quote} onClick={onOpen} title="Ir al mensaje original">{content}</button>
    : <div data-attention="message-quote" className={styles.quote}>{content}{!quote.id && <small>El mensaje original no está disponible en este historial.</small>}</div>;
}

export function AttentionReplyReference({ quote, disabled, onCancel }: { quote: AttentionQuote; disabled: boolean; onCancel: () => void }) {
  return <div className={styles.replyReference} data-attention="reply-reference"><Reply aria-hidden="true" size={21} /><div><small>Respondiendo a {quote.author || "un mensaje"}</small><span>{attentionMessageSummary(quote)}</span></div><button type="button" disabled={disabled} aria-label="Cancelar respuesta a este mensaje" onClick={onCancel}><X aria-hidden="true" size={20} /></button></div>;
}

type Close = (restore?: boolean) => void;
let closeActive: { id: string; close: Close } | null = null;
export default function AttentionMessageActions({ message, disabled, canReply, canForward, onReply, onForward, onSaveSticker }: {
  message: AttentionMessage; disabled: boolean; canReply: boolean; canForward: boolean;
  onReply: () => void; onForward: () => void; onSaveSticker?: () => void;
}) {
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 12, top: 12, width: 220, maxHeight: 260 });
  const close = useCallback((restore = true) => {
    setOpen(false); if (closeActive?.id === id) closeActive = null;
    if (restore && anchor.current?.isConnected) anchor.current.focus();
  }, [id]);
  useEffect(() => { if (!disabled) return; const timer = setTimeout(() => close(false), 0); return () => clearTimeout(timer); }, [disabled, close]);
  useEffect(() => () => { if (closeActive?.id === id) closeActive = null; }, [id]);
  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      if (!anchor.current) return;
      const viewport = window.visualViewport, margin = 12;
      const width = Math.min(220, (viewport?.width ?? window.innerWidth) - margin * 2), maxHeight = Math.min(280, (viewport?.height ?? window.innerHeight) - margin * 2);
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0, rect = anchor.current.getBoundingClientRect();
      const right = left + (viewport?.width ?? window.innerWidth), bottom = top + (viewport?.height ?? window.innerHeight), height = Math.min(popup.current?.getBoundingClientRect().height || 152, maxHeight);
      setPosition({ width, maxHeight, left: Math.max(left + margin, Math.min(rect.right - width, right - width - margin)), top: Math.max(top + margin, Math.min(rect.bottom + height + margin < bottom ? rect.bottom + 4 : rect.top - height - 4, bottom - height - margin)) });
    };
    const outside = (event: Event) => { const target = event.target as Node | null; if (target && !popup.current?.contains(target) && !anchor.current?.contains(target)) close(false); };
    const moved = (event: Event) => { if (event.target instanceof Node && popup.current?.contains(event.target)) return; close(false); };
    positionMenu(); popup.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside, true);
    window.addEventListener("scroll", moved, true); window.addEventListener("resize", moved);
    window.visualViewport?.addEventListener("resize", moved);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); window.removeEventListener("scroll", moved, true); window.removeEventListener("resize", moved); window.visualViewport?.removeEventListener("resize", moved); };
  }, [open, close]);
  if (!canReply && !canForward && !onSaveSticker) return null;
  function choose(callback: () => void) { close(); callback(); }
  return <><button type="button" ref={anchor} className={styles.trigger} aria-label="Opciones del mensaje" title="Opciones del mensaje" aria-haspopup="menu" aria-controls={open ? id : undefined} aria-expanded={open} disabled={disabled} onClick={() => { if (open) close(); else { closeActive?.close(false); closeActive = { id, close }; setOpen(true); } }} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); closeActive?.close(false); closeActive = { id, close }; setOpen(true); } }}><ChevronDown aria-hidden="true" size={18} /></button>
    {open && !disabled && createPortal(<div ref={popup} id={id} className={styles.menu} style={position} role="menu" aria-label="Opciones del mensaje" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === "Tab") { close(false); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement), next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus();
    }}>
      {canReply && <button type="button" role="menuitem" onClick={() => choose(onReply)}><Reply aria-hidden="true" size={20} />Responder</button>}
      {canForward && <button type="button" role="menuitem" onClick={() => choose(onForward)}><Forward aria-hidden="true" size={20} />Reenviar</button>}
      {onSaveSticker && message.attachment?.kind === "sticker" && <button type="button" role="menuitem" onClick={() => choose(onSaveSticker)}><Sticker aria-hidden="true" size={20} />Guardar sticker</button>}
    </div>, document.body)}
  </>;
}
