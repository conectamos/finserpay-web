// Additive: keep all existing ally records and any already registered contacts.
export const ALLY_CONTACT_SCHEMA_SQL = `
  ALTER TABLE public."Aliado"
    ADD COLUMN IF NOT EXISTS "email" TEXT,
    ADD COLUMN IF NOT EXISTS "telefonoWhatsapp" TEXT
`;

export async function ensureAllyContactSchema(client) {
  await client.query(ALLY_CONTACT_SCHEMA_SQL);
  const { rows } = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Aliado'
      AND column_name IN ('email', 'telefonoWhatsapp')
  `);
  for (const name of ["email", "telefonoWhatsapp"]) {
    const column = rows.find((row) => row.column_name === name);
    if (!column || column.data_type !== "text" || column.is_nullable !== "YES") {
      throw new Error(`Definición incompatible en Aliado.${name}.`);
    }
  }
}
