"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Bell, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import { attentionNotificationHref, isAttentionNotificationWorkId } from "@/lib/atencion-notification-links";
import { ATTENTION_PUSH_SCOPE, ATTENTION_PUSH_WORKER, attentionPushKey, getAttentionPushRegistration, stopAttentionDevicePush, waitForAttentionPushWorker } from "@/lib/atencion-notification-browser";
import styles from "./attention-notifications.module.css";

type NotificationItem = { id: string; kind: "created" | "reply" | "assigned" | "followup"; workKind: "welcome" | "enrollment"; title: string; description: string; createdAt: string; readAt: string | null; href: string };
type NotificationSummary = { items: NotificationItem[]; unreadCount: number; actorKey: string };
type PushConfiguration = { publicKey: string | null; configured: boolean; subscribed?: boolean };
const NotificationContext = createContext<{ count: number; open: () => void } | null>(null);

export function AttentionNotificationBell() {
  const notifications = useContext(NotificationContext);
  if (!notifications) return null;
  return <button type="button" className={styles.bell} aria-label={`Notificaciones de solicitudes${notifications.count ? `: ${notifications.count} sin leer` : ""}`} aria-haspopup="dialog" onClick={notifications.open}>
    <Bell size={20} aria-hidden="true" />{notifications.count > 0 && <span className={styles.count} aria-hidden="true">{notifications.count > 99 ? "99+" : notifications.count}</span>}
  </button>;
}

function validSummary(value: NotificationSummary, actorKey: string) {
  return value?.actorKey === actorKey && Number.isSafeInteger(value.unreadCount) && value.unreadCount >= 0 && Array.isArray(value.items) && value.items.every(item =>
    isAttentionNotificationWorkId(item.id) && typeof item.title === "string" && typeof item.description === "string" && Number.isFinite(Date.parse(item.createdAt)) && attentionNotificationHref(item.href));
}
function time(value: string) { return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
async function writeNotification(url: string, method: "PATCH" | "POST" | "DELETE", body: object) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try { return await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

export default function AttentionNotifications({ actorKey, endpoint, children }: { actorKey: string | null; endpoint: string | null; children: ReactNode }) {
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(Boolean(actorKey && endpoint));
  const [error, setError] = useState("");
  const [marking, setMarking] = useState(false);
  const [pushConfig, setPushConfig] = useState<PushConfiguration | null>(null);
  const [pushActive, setPushActive] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState("");
  const [pushSupported, setPushSupported] = useState(false);
  const [installRequired, setInstallRequired] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const mounted = useRef(false), blocked = useRef(false), request = useRef<AbortController | null>(null), pushOperation = useRef(false);

  const revoke = useCallback(() => {
    blocked.current = true; setAllowed(false); setSummary(null); setOpen(false); setPushActive(false); setPushConfig(null);
    void stopAttentionDevicePush();
  }, []);
  const refresh = useCallback(async () => {
    if (!actorKey || !endpoint || blocked.current || request.current || document.visibilityState !== "visible" || navigator.onLine === false) return;
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      if ([401, 403].includes(response.status)) { revoke(); return; }
      if (!response.ok) throw new Error("No pudimos actualizar las notificaciones. Reintentaremos automáticamente.");
      const next = await response.json() as NotificationSummary;
      if (!mounted.current || controller.signal.aborted || blocked.current) return;
      if (next.actorKey !== actorKey) { revoke(); return; }
      if (!validSummary(next, actorKey)) throw new Error("No pudimos consultar las notificaciones.");
      setSummary(next); setError("");
    } catch (failure) {
      if (mounted.current && !blocked.current) setError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "La consulta tardó demasiado. Reintentaremos automáticamente.");
    } finally { clearTimeout(timeout); if (request.current === controller) request.current = null; }
  }, [actorKey, endpoint, revoke]);

  useEffect(() => {
    mounted.current = true; blocked.current = false;
    setAllowed(Boolean(actorKey && endpoint)); setSummary(null); setError(""); setPushConfig(null); setPushActive(false);
    setOpen(Boolean(actorKey && new URLSearchParams(window.location.search).get("notifications") === "1"));
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setInstallRequired(ios && !standalone);
    setPushSupported("serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext);
    if ("Notification" in window) setPermission(Notification.permission);
    const wake = () => { void refresh(); };
    const disabled = () => setPushActive(false);
    const fromWorker = (event: MessageEvent) => {
      if (event.data?.type === "FINSERPAY_OPEN_NOTIFICATIONS" && actorKey && !blocked.current) { setOpen(true); void refresh(); }
    };
    window.addEventListener("focus", wake); window.addEventListener("online", wake); document.addEventListener("visibilitychange", wake);
    window.addEventListener("finser:attention-push-disabled", disabled);
    navigator.serviceWorker?.addEventListener("message", fromWorker);
    const timer = setInterval(wake, 15000); void refresh();
    return () => { mounted.current = false; clearInterval(timer); request.current?.abort(); request.current = null; window.removeEventListener("focus", wake); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); window.removeEventListener("finser:attention-push-disabled", disabled); navigator.serviceWorker?.removeEventListener("message", fromWorker); };
  }, [actorKey, endpoint, refresh]);

  useEffect(() => {
    if (!open || !allowed || !endpoint) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const load = async () => {
      try {
        const registration = await getAttentionPushRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        const response = await fetch(`${endpoint}/push${subscription ? `?endpoint=${encodeURIComponent(subscription.endpoint)}` : ""}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (cancelled || blocked.current) return;
        if ([401, 403].includes(response.status)) { revoke(); return; }
        if (!response.ok) throw new Error("No pudimos consultar los avisos al celular. Cierra y vuelve a abrir este panel.");
        const config = await response.json() as PushConfiguration;
        if (cancelled || blocked.current) return;
        setPushConfig(config); setPushActive(Boolean(subscription && config.subscribed)); setPushError("");
        if (subscription && !config.subscribed) await subscription.unsubscribe();
        if ("Notification" in window) setPermission(Notification.permission);
      } catch (failure) { if (!cancelled) setPushError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "No se pudo consultar la configuración. Vuelve a abrir este panel."); }
      finally { clearTimeout(timeout); }
    };
    void load();
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout); };
  }, [open, allowed, endpoint, revoke]);

  async function acknowledge(ids: string[]) {
    if (!endpoint || blocked.current || !ids.length || marking) return;
    setMarking(true);
    try {
      const response = await writeNotification(endpoint, "PATCH", { ids });
      if ([401, 403].includes(response.status)) { revoke(); return; }
      if (!response.ok) throw new Error("No pudimos marcar el aviso como leído.");
      if (mounted.current && !blocked.current) { setSummary(current => current ? { ...current, unreadCount: Math.max(0, current.unreadCount - current.items.filter(item => ids.includes(item.id) && !item.readAt).length), items: current.items.map(item => ids.includes(item.id) ? { ...item, readAt: item.readAt || new Date().toISOString() } : item) } : null); void refresh(); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "No pudimos marcar el aviso como leído."); }
    finally { if (mounted.current) setMarking(false); }
  }

  async function activatePush() {
    if (!endpoint || !pushConfig?.configured || !pushConfig.publicKey || blocked.current || pushOperation.current || installRequired || !pushSupported) return;
    pushOperation.current = true; setPushBusy(true); setPushError("");
    let created: PushSubscription | null = null;
    try {
      // Permission must be requested directly from the user's click, before other asynchronous work.
      const permitted = await Notification.requestPermission(); setPermission(permitted);
      if (permitted !== "granted") throw new Error(permitted === "denied" ? "Las notificaciones están bloqueadas. Permítelas en los ajustes de este navegador." : "No se activaron las notificaciones. Puedes volver a intentarlo.");
      const registration = await navigator.serviceWorker.register(ATTENTION_PUSH_WORKER, { scope: ATTENTION_PUSH_SCOPE, updateViaCache: "none" });
      await waitForAttentionPushWorker(registration);
      if (!mounted.current || blocked.current) return;
      const existing = await registration.pushManager.getSubscription();
      created = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: attentionPushKey(pushConfig.publicKey) });
      const response = await writeNotification(`${endpoint}/push`, "POST", { subscription: created.toJSON() });
      if (!response.ok) { if ([401, 403].includes(response.status)) revoke(); throw new Error("No se pudo activar este dispositivo. Vuelve a intentarlo."); }
      if (!mounted.current || blocked.current) { await created.unsubscribe(); return; }
      setPushActive(true);
    } catch (failure) {
      await created?.unsubscribe().catch(() => false);
      if (mounted.current) setPushError(failure instanceof Error ? failure.message : "No se pudo activar este dispositivo.");
    } finally { pushOperation.current = false; if (mounted.current) setPushBusy(false); }
  }

  async function deactivatePush() {
    if (!endpoint || pushOperation.current) return;
    pushOperation.current = true; setPushBusy(true); setPushError("");
    try {
      const registration = await getAttentionPushRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const response = await writeNotification(`${endpoint}/push`, "DELETE", { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        if (!response.ok && ![401, 403].includes(response.status)) throw new Error("Se desactivó este navegador. No pudimos confirmar la baja del registro; vuelve a intentarlo.");
      }
      setPushActive(false);
    } catch (failure) { await stopAttentionDevicePush(); setPushActive(false); setPushError(failure instanceof Error ? failure.message : "No pudimos confirmar la desactivación."); }
    finally { pushOperation.current = false; if (mounted.current) setPushBusy(false); }
  }

  const visibleUnread = summary?.items.filter(item => !item.readAt).map(item => item.id) || [];
  return <NotificationContext.Provider value={allowed ? { count: summary?.unreadCount || 0, open: () => { setOpen(true); void refresh(); } } : null}>
    {children}
    {allowed && <><span className={styles.live} role="status" aria-live="polite">{summary?.unreadCount ? `${summary.unreadCount} notificaciones de solicitudes sin leer.` : ""}</span>
      <FinserSidePanel open={open} title="Notificaciones" closeLabel="Cerrar notificaciones" busy={pushBusy} onClose={() => setOpen(false)}>
        <div className={styles.summary}><p>{summary ? `${summary.unreadCount} sin leer` : "Consultando notificaciones…"}</p><Button variant="ghost" aria-label="Actualizar notificaciones" onClick={() => void refresh()}><RefreshCw size={18} aria-hidden="true" /></Button></div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {visibleUnread.length > 0 && <div className={styles.summary}><Button variant="secondary" disabled={marking} onClick={() => void acknowledge(visibleUnread)}>{marking ? "Guardando…" : "Marcar estos avisos como leídos"}</Button></div>}
        <ul className={styles.list}>{summary?.items.map(item => <li key={item.id}><a className={`${styles.item} ${!item.readAt ? styles.unread : ""}`} href={attentionNotificationHref(item.href)!} onClick={() => { if (!item.readAt) void acknowledge([item.id]); }}><span className={styles.dot} aria-hidden="true" /><span><strong>{item.title}{!item.readAt && <span className={styles.live}> · Sin leer</span>}</strong><p>{item.description}</p><time dateTime={item.createdAt}>{time(item.createdAt)}</time></span><ArrowUpRight size={17} aria-hidden="true" /></a></li>)}</ul>
        {summary && !summary.items.length && <p className={styles.empty}>No tienes notificaciones de solicitudes todavía.</p>}
        <section className={styles.push} aria-labelledby="attention-push-title"><h3 id="attention-push-title"><Smartphone size={20} aria-hidden="true" />Avisos en este dispositivo</h3><p>Recibe avisos de solicitudes aunque FINSER PAY esté cerrado. En la pantalla bloqueada se muestra un aviso sin datos del cliente.</p>
          {installRequired ? <p className={styles.help}>En iPhone o iPad, abre FINSER PAY en Safari, pulsa Compartir → Agregar a inicio. Abre la plataforma desde ese icono, inicia sesión con tu perfil y activa aquí los avisos. Requiere iOS 16.4 o posterior.</p>
            : !pushSupported ? <p className={styles.help}>Este navegador no admite avisos con la plataforma cerrada. La campana sigue disponible mientras usas FINSER PAY.</p>
            : pushConfig && !pushConfig.configured ? <p className={styles.help}>Los avisos al celular están pendientes de configuración. Las notificaciones de la campana ya están disponibles.</p>
            : pushActive ? <><p role="status">Avisos activados para tu perfil en este dispositivo.</p><Button variant="secondary" disabled={pushBusy} onClick={() => void deactivatePush()}>{pushBusy ? "Desactivando…" : "Desactivar avisos"}</Button></>
            : <><Button disabled={pushBusy || !pushConfig?.configured || permission === "denied"} onClick={() => void activatePush()}>{pushBusy ? "Activando…" : "Activar avisos en este dispositivo"}</Button>{permission === "denied" && <p className={styles.help}>Permite las notificaciones de FINSER PAY en los ajustes del navegador y vuelve a abrir este panel.</p>}</>}
          {pushError && <p className={styles.error} role="alert">{pushError}</p>}<p>Si compartes el equipo, cierra sesión al terminar. Los avisos se desactivan al salir o cambiar de perfil.</p>
        </section>
      </FinserSidePanel>
    </>}
  </NotificationContext.Provider>;
}
