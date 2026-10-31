/** Dashboard-only push registration. Never touch the customer service worker. */
export const ATTENTION_PUSH_SCOPE = "/dashboard/";
export const ATTENTION_PUSH_WORKER = "/dashboard/notifications-sw.js";

export async function getAttentionPushRegistration() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration(ATTENTION_PUSH_SCOPE);
  return registration?.scope === new URL(ATTENTION_PUSH_SCOPE, window.location.origin).href ? registration : null;
}

/** Browser-side defense on shared devices; the session endpoints also revoke the server binding. */
export async function stopAttentionDevicePush() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const registration = await getAttentionPushRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
        window.dispatchEvent(new Event("finser:attention-push-disabled"));
      })(),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 2000); }),
    ]);
  } catch { /* Logout must remain possible even when browser push is unavailable. */ }
  finally { if (timeout) clearTimeout(timeout); }
}

export function attentionPushKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

export async function waitForAttentionPushWorker(registration: ServiceWorkerRegistration) {
  if (registration.active) return;
  const worker = registration.installing || registration.waiting;
  if (!worker) throw new Error("No se pudo preparar las notificaciones. Vuelve a intentarlo.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); worker.removeEventListener("statechange", change); };
    const change = () => {
      if (worker.state === "activated") { cleanup(); resolve(); }
      else if (worker.state === "redundant") { cleanup(); reject(new Error("La instalación se interrumpió. Vuelve a intentarlo.")); }
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("La instalación tardó demasiado. Vuelve a intentarlo.")); }, 15000);
    worker.addEventListener("statechange", change);
    change();
  });
}
