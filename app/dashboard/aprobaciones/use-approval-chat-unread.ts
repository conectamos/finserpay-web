"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isWelcomeChatWorkId } from "@/lib/atencion-work-links";
import type { AttentionWorkSummary } from "@/lib/atencion-work-types";

type Marker = { id: string; sentAt: string } | null;
type State = { key: string; count: number | null; hasNew: boolean; arrival: number; denied: boolean; unavailable: boolean };
const epoch = (value: string) => Date.parse(value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/i, "$1"));
const validMarker = (value: unknown): value is Marker => value === null || Boolean(value && typeof value === "object"
  && isWelcomeChatWorkId((value as Marker)?.id) && typeof (value as Marker)?.sentAt === "string" && Number.isFinite(epoch((value as Exclude<Marker, null>).sentAt)));
function advances(next: Marker, previous: Marker) {
  if (!next) return false;
  if (!previous) return true;
  const difference = epoch(next.sentAt) - epoch(previous.sentAt);
  const fraction = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1] || "").padEnd(9, "0").slice(3, 9);
  const precise = fraction(next.sentAt).localeCompare(fraction(previous.sentAt));
  return difference > 0 || difference === 0 && (precise > 0 || precise === 0 && next.id.toLowerCase() > previous.id.toLowerCase());
}

/** Consults read state only; visible-message acknowledgement remains in AttentionObservedRead. */
export function useApprovalChatUnread(workId: string, creditId: number) {
  const key = JSON.stringify([workId, creditId]);
  const valid = isWelcomeChatWorkId(workId) && Number.isSafeInteger(creditId) && creditId > 0;
  const [state, setState] = useState<State | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => { refreshRef.current?.(); }, []);

  useEffect(() => {
    if (!valid) return;
    let disposed = false, stopped = false, inFlight = false, trailing = false, baseline = false;
    let previousCount = 0, highWater: Marker = null, arrival = 0, hasNew = false;
    let controller: AbortController | null = null, source: EventSource | undefined;
    let queued: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const deny = () => {
      stopped = true; hasNew = false; controller?.abort(); source?.close();
      if (queued) clearTimeout(queued); if (deadline) clearTimeout(deadline); if (poll) clearInterval(poll);
      if (!disposed) setState({ key, count: null, hasNew: false, arrival, denied: true, unavailable: false });
    };
    const schedule = () => {
      if (disposed || stopped || document.visibilityState !== "visible") return;
      if (inFlight) { trailing = true; return; }
      if (!queued) queued = setTimeout(() => { queued = undefined; void load(); }, 150);
    };
    const load = async () => {
      if (disposed || stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const read = new AbortController(); controller = read;
      let timedOut = false;
      deadline = setTimeout(() => { timedOut = true; read.abort(); }, 15_000);
      try {
        const query = new URLSearchParams({ target: `C-${creditId}` });
        const response = await fetch(`/api/atencion/solicitudes/${encodeURIComponent(workId)}/resumen?${query}`, {
          credentials: "same-origin", cache: "no-store", signal: read.signal,
        });
        if (disposed || stopped) return;
        if (read.signal.aborted) { if (timedOut) throw new Error("Consulta agotada"); return; }
        if ([401, 403, 404, 409].includes(response.status)) { deny(); return; }
        const payload = await response.json().catch(() => null) as AttentionWorkSummary | null;
        if (disposed || stopped) return;
        if (read.signal.aborted) { if (timedOut) throw new Error("Consulta agotada"); return; }
        if (!response.ok) throw new Error("Resumen no disponible");
        if (payload?.workId !== workId || payload?.kind !== "welcome" || payload?.target !== `C-${creditId}`) { deny(); return; }
        if (!Number.isSafeInteger(payload.unreadCount) || payload.unreadCount < 0 || !validMarker(payload.lastInbound)
          || !validMarker(payload.lastUnreadInbound) || (payload.unreadCount > 0 && (!payload.lastUnreadInbound || !payload.lastInbound))
          || (payload.unreadCount === 0 && payload.lastUnreadInbound !== null)) throw new Error("Resumen inválido");
        const incoming = baseline && payload.unreadCount > 0 && (payload.unreadCount > previousCount || advances(payload.lastUnreadInbound, highWater));
        if (incoming) { arrival++; hasNew = true; }
        if (payload.unreadCount === 0) hasNew = false;
        if (advances(payload.lastInbound, highWater)) highWater = payload.lastInbound;
        previousCount = payload.unreadCount; baseline = true;
        setState({ key, count: payload.unreadCount, hasNew, arrival, denied: false, unavailable: false });
      } catch {
        if (!disposed && !stopped && (!read.signal.aborted || timedOut)) {
          hasNew = false;
          setState({ key, count: null, hasNew: false, arrival, denied: false, unavailable: true });
        }
      } finally {
        if (deadline) clearTimeout(deadline); deadline = undefined;
        if (controller === read) controller = null;
        inFlight = false;
        if (trailing) { trailing = false; schedule(); }
      }
    };
    refreshRef.current = schedule;
    void load();
    const poll = setInterval(schedule, 5_000);
    window.addEventListener("focus", schedule); window.addEventListener("online", schedule);
    document.addEventListener("visibilitychange", schedule);
    if (typeof EventSource !== "undefined") {
      try {
        source = new EventSource("/api/atencion/events");
        for (const event of ["ready", "invalidate", "degraded", "error"]) source.addEventListener(event, schedule);
        source.addEventListener("unauthorized", deny);
      } catch { /* Periodic reads remain available when live events cannot connect. */ }
    }
    return () => {
      disposed = true; controller?.abort(); source?.close();
      if (queued) clearTimeout(queued); if (deadline) clearTimeout(deadline); if (poll) clearInterval(poll);
      window.removeEventListener("focus", schedule); window.removeEventListener("online", schedule);
      document.removeEventListener("visibilitychange", schedule);
      if (refreshRef.current === schedule) refreshRef.current = null;
    };
  }, [key, workId, creditId, valid]);

  const current = state?.key === key ? state : null;
  return { count: current?.count ?? null, hasNew: current?.hasNew ?? false, arrival: current?.arrival ?? 0,
    denied: !valid || (current?.denied ?? false), unavailable: current?.unavailable ?? false, refresh };
}
