const baseUrl = String(process.env.FINSERPAY_BASE_URL || "https://finserpay.com").replace(/\/+$/, "");
if (new URL(baseUrl).protocol !== "https:") throw new Error("FINSERPAY_BASE_URL debe usar HTTPS.");
const token = String(process.env.MERCHANT_APPLICATION_RETRY_TOKEN || process.env.CRON_SECRET || "").trim();
if (token.length < 32) throw new Error("Configura MERCHANT_APPLICATION_RETRY_TOKEN o CRON_SECRET (mínimo 32 caracteres).");
try {
  const response = await fetch(`${baseUrl}/api/postulaciones/reintentar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(process.argv[2] ? { solicitudId: process.argv[2] } : { limit: 10 }),
    signal: AbortSignal.timeout(145_000),
  });
  const payload = await response.json();
  // The endpoint returns only counters, never merchant details or credentials.
  console.log(JSON.stringify({ ok: response.ok && payload.ok, summary: payload.summary || null }));
  if (!response.ok || !payload.ok) process.exitCode = 1;
} catch { console.error("No se pudo ejecutar el reintento de notificaciones."); process.exitCode = 1; }
