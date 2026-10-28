// Additive only. Existing legacy sessions remain eligible until their account's
// password-change flow writes the marker. Never clear an existing revocation.
export const ADMIN_SESSION_SCHEMA_SQL = `
  ALTER TABLE public."Usuario"
    ADD COLUMN IF NOT EXISTS "legacySessionRevokedAt" TIMESTAMP(3)
`;

export async function ensureAdminSessionSchema(client) {
  await client.query(ADMIN_SESSION_SCHEMA_SQL);
  const { rows } = await client.query(`
    SELECT data_type, udt_schema, udt_name, is_nullable, column_default,
      datetime_precision, is_identity, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Usuario'
      AND column_name = 'legacySessionRevokedAt'
  `);
  const column = rows[0];
  if (rows.length !== 1 || column.data_type !== "timestamp without time zone" ||
    column.udt_schema !== "pg_catalog" || column.udt_name !== "timestamp" ||
    column.is_nullable !== "YES" || column.column_default !== null ||
    Number(column.datetime_precision) !== 3 || column.is_identity !== "NO" || column.is_generated !== "NEVER") {
    throw new Error("Definición incompatible en Usuario.legacySessionRevokedAt.");
  }
}

export async function installAdminSessionSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-admin-session-schema'))");
    await ensureAdminSessionSchema(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
