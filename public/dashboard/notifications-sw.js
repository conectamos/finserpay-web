// Separate scope from the customer portal. Never cache authenticated pages or APIs.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show a generic visible notification. */ }
  event.waitUntil(self.registration.showNotification("FINSER PAY · Solicitudes", {
    body: typeof payload.body === "string" ? payload.body.slice(0,180) : "Tienes una nueva notificación. Abre la plataforma para consultarla.",
    tag: typeof payload.tag === "string" ? payload.tag.slice(0,80) : "finserpay-work",
    icon: "/icons/finserpay-client-192.png",
    badge: "/icons/finserpay-client-192.png",
    data: { url: "/dashboard?notifications=1" }
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const existing = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && /^\/dashboard(?:\/|$)/.test(url.pathname);
    });
    if(existing){
      // Preserve an unsent draft in an existing dashboard tab.
      existing.postMessage({type:"FINSERPAY_OPEN_NOTIFICATIONS"});
      await existing.focus();
    } else await self.clients.openWindow("/dashboard?notifications=1");
  })());
});
