"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { AttentionQuickReply } from "@/lib/atencion-types";
import styles from "./attention-quick-reply-shortcuts.module.css";

type Selection = { value: string; start: number; end: number };
type SlashToken = { start: number; end: number; query: string; key: string };
type Options = {
  text: string; replies: AttentionQuickReply[]; disabled: boolean; maxLength: number;
  onChange: (text: string) => void; onError: (message: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
function tokenAt(selection: Selection | null): SlashToken | null {
  if (!selection || selection.start !== selection.end) return null;
  const { value, start: caret } = selection;
  if (caret < 0 || caret > value.length) return null;
  const match = /(^|\s)\/([^\s/]*)$/u.exec(value.slice(0, caret));
  if (!match) return null;
  const start = match.index + match[1].length;
  const end = caret + (/^[^\s/]*/u.exec(value.slice(caret))?.[0].length || 0);
  return { start, end, query: match[2], key: `${start}:${match[2]}` };
}
function selectionOf(input: HTMLTextAreaElement | null): Selection | null {
  return input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd } : null;
}
function matches(replies: AttentionQuickReply[], token: SlashToken) {
  const query = normalize(token.query);
  return replies.filter(reply => normalize(`${reply.title}\n${reply.text}`).includes(query)).slice(0, 8);
}

/** Inserts approved text into a draft. Selection never sends the message. */
export function useAttentionQuickReplyShortcuts({ text, replies, disabled, maxLength, onChange, onError, inputRef }: Options) {
  const id = `attention-quick-replies-${useId().replace(/:/g, "")}`;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ key: string; index: number } | null>(null);
  const restoreCaret = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const context = useRef({ text, replies, disabled, maxLength, onChange, onError, inputRef });
  useLayoutEffect(() => { context.current = { text, replies, disabled, maxLength, onChange, onError, inputRef }; }, [text, replies, disabled, maxLength, onChange, onError, inputRef]);
  const token = selection?.value === text ? tokenAt(selection) : null;
  const open = !disabled && token !== null && token.key !== dismissed;
  const results = token ? matches(replies, token) : [];
  const activeIndex = token && highlight?.key === token.key ? Math.min(highlight.index, Math.max(0, results.length - 1)) : 0;

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!list || !option) return;
    const viewport = list.getBoundingClientRect();
    const selected = option.getBoundingClientRect();
    // Scroll only this popup, never the chat, page or another enclosing panel.
    if (selected.top < viewport.top) list.scrollTop += selected.top - viewport.top;
    else if (selected.bottom > viewport.bottom) list.scrollTop += selected.bottom - viewport.bottom;
  }, [open, activeIndex, token?.key, replies]);

  function onCaretChange() {
    const next = selectionOf(inputRef.current);
    setSelection(previous => previous?.value === next?.value && previous?.start === next?.start && previous?.end === next?.end ? previous : next);
    setDismissed(previous => previous !== null && tokenAt(next)?.key !== previous ? null : previous);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      const input = inputRef.current;
      if (!input || input.value !== text) return;
      const next = selectionOf(input);
      setSelection(previous => previous?.value === next?.value && previous?.start === next?.start && previous?.end === next?.end ? previous : next);
      setDismissed(previous => previous !== null && tokenAt(next)?.key !== previous ? null : previous);
    }, 0);
    return () => clearTimeout(timer);
  }, [text, inputRef]);
  useEffect(() => () => { if (restoreCaret.current !== null) clearTimeout(restoreCaret.current); }, []);

  function insert(reply: AttentionQuickReply, expected: SlashToken) {
    const latest = context.current;
    const input = latest.inputRef.current;
    const current = selectionOf(input);
    const currentToken = tokenAt(current);
    if (latest.disabled || !input || !current || !currentToken || current.value !== latest.text || currentToken.key !== expected.key || !latest.replies.some(item => item.id === reply.id && item.text === reply.text)) return;
    const next = `${current.value.slice(0, currentToken.start)}${reply.text}${current.value.slice(currentToken.end)}`;
    if (next.length > latest.maxLength) {
      latest.onError(`La respuesta rápida supera el límite de ${latest.maxLength} caracteres. Acorta el borrador antes de insertarla.`);
      return;
    }
    const caret = currentToken.start + reply.text.length;
    latest.onChange(next);
    setSelection({ value: next, start: caret, end: caret });
    setDismissed(null); setHighlight(null);
    if (restoreCaret.current !== null) clearTimeout(restoreCaret.current);
    restoreCaret.current = setTimeout(() => {
      restoreCaret.current = null;
      if (context.current.disabled || context.current.inputRef.current !== input || input.value !== next || input.disabled) return;
      input.focus(); input.setSelectionRange(caret, caret);
    }, 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (disabled || event.defaultPrevented || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    const current = selectionOf(event.currentTarget);
    const currentToken = tokenAt(current);
    if (!currentToken || current?.value !== text || currentToken.key === dismissed || !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return false;
    event.preventDefault();
    // A held Enter never inserts the quick reply again.
    if (event.repeat) return true;
    const available = matches(replies, currentToken);
    const index = highlight?.key === currentToken.key ? Math.min(highlight.index, Math.max(0, available.length - 1)) : 0;
    setSelection(current);
    if (event.key === "Escape") setDismissed(currentToken.key);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (available.length) setHighlight({ key: currentToken.key, index: (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length });
    } else if (available[index]) insert(available[index], currentToken);
    return true;
  }

  const menu = open && token ? <div className={styles.popup} data-attention="quick-reply-shortcuts">
    <div className={styles.heading}><strong>Respuestas rápidas</strong><span>↑ ↓ elegir · Enter insertar · Esc cerrar</span></div>
    <div ref={listRef} id={id} role="listbox" aria-label="Respuestas rápidas aprobadas" className={styles.list}>
      {results.length ? results.map((reply, index) => <button type="button" role="option" id={`${id}-${index}`} key={reply.id} aria-selected={index === activeIndex} tabIndex={-1} className={styles.option}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setHighlight({ key: token.key, index })} onClick={() => insert(reply, token)}>
        <strong>{reply.title}</strong><span>{reply.text}</span>
      </button>) : <p className={styles.empty} role="status">{replies.length ? "No hay respuestas que coincidan. Cambia la búsqueda o pulsa Escape para continuar escribiendo." : "No hay respuestas rápidas aprobadas."}</p>}
    </div>
    <p className={styles.footer}>Se inserta en el borrador para que lo revises antes de enviar.</p>
  </div> : null;

  return {
    onKeyDown, onCaretChange, menu, expanded: open,
    popupProps: {
      "aria-autocomplete": "list" as const,
      "aria-haspopup": "listbox" as const,
      "aria-controls": open ? id : undefined,
      "aria-activedescendant": open && results.length ? `${id}-${activeIndex}` : undefined,
    },
  };
}
