/** Limit notification navigation to the two authorized work inboxes. */
export function attentionNotificationHref(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/dashboard/") || value.startsWith("//")) return null;
  const url = new URL(value, "https://finser.invalid");
  if (!["/dashboard/atencion", "/dashboard/gestion-comercial"].includes(url.pathname) || url.hash) return null;
  if ([...url.searchParams.keys()].some(key => !["tipo", "solicitud"].includes(key))) return null;
  if (url.searchParams.getAll("tipo").length !== 1 || url.searchParams.getAll("solicitud").length > 1) return null;
  const tipo = url.searchParams.get("tipo");
  if (tipo !== "welcome" && tipo !== "enrollment") return null;
  const id = url.searchParams.get("solicitud");
  if (id !== null && !isAttentionNotificationWorkId(id)) return null;
  return `${url.pathname}?tipo=${tipo}${id ? `&solicitud=${id}` : ""}`;
}

export function isAttentionNotificationWorkId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
