/** Display the backend's reset timestamp in Colombia, never the browser's clock. */
export function formatQuotaRehabilitationDate(resetsAt: string): string | null {
  // The quota API serializes its PostgreSQL timestamp with Date.toISOString().
  // Reject date-only values and impossible calendar dates instead of guessing.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(resetsAt)) return null;
  const date = new Date(resetsAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== resetsAt) return null;
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(date);
}
