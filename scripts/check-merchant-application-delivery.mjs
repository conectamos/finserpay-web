import pg from "pg";

const applicationId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicationId || "")) {
  throw new Error("Uso: node scripts/check-merchant-application-delivery.mjs <solicitudId>");
}
if (!process.env.DATABASE_URL || !process.env.RESEND_API_KEY) throw new Error("Configura DATABASE_URL y RESEND_API_KEY en el servidor.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  const result = await client.query('SELECT "notificationStatus", "providerEmailId", "lastErrorCode" FROM "MerchantApplication" WHERE "id" = $1::uuid', [applicationId]);
  const row = result.rows[0];
  if (!row) throw new Error("Solicitud no encontrada.");
  if (!row.providerEmailId) {
    console.log(JSON.stringify({ solicitudId: applicationId, status: row.notificationStatus, code: row.lastErrorCode, delivered: false }));
    process.exitCode = 2;
  } else {
    const response = await fetch(`https://api.resend.com/emails/${row.providerEmailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("No se pudo consultar entrega. Verifica permisos de lectura de emails de RESEND_API_KEY.");
    const email = await response.json();
    if (email.id !== row.providerEmailId || !Array.isArray(email.to) || !email.to.includes("comercial@finserpay.com")) {
      throw new Error("La respuesta no corresponde al correo esperado.");
    }
    const delivered = ["delivered", "opened", "clicked"].includes(email.last_event);
    if (delivered) {
      await client.query(`UPDATE "MerchantApplication" SET "notificationStatus" = 'DELIVERED', "deliveredAt" = COALESCE("deliveredAt", NOW()), "updatedAt" = NOW() WHERE "id" = $1::uuid AND "providerEmailId" = $2::uuid`, [applicationId, row.providerEmailId]);
    }
    const knownEvents = ["sent", "delivered", "opened", "clicked", "bounced", "complained", "delivery_delayed", "failed", "suppressed"];
    const providerEvent = knownEvents.includes(email.last_event) ? email.last_event : "unknown";
    console.log(JSON.stringify({ solicitudId: applicationId, providerEmailId: row.providerEmailId, providerEvent, delivered }));
    if (!delivered) process.exitCode = 2;
  }
} catch (error) {
  // Only our fixed errors are public. Never echo database/provider response bodies.
  const safeMessages = ["Solicitud no encontrada.", "No se pudo consultar entrega. Verifica permisos de lectura de emails de RESEND_API_KEY.", "La respuesta no corresponde al correo esperado."];
  console.error(safeMessages.includes(error?.message) ? error.message : "No se pudo comprobar la entrega de la notificación.");
  process.exitCode = 1;
} finally { await client.end().catch(() => undefined); }
