import pg from "pg";

const { Client } = pg;
const COLUMN_NAME = "iphoneSelfieCedulaDataUrl";
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error("DATABASE_URL no esta configurada para preparar el esquema iPhone.");
}

const client = new Client({
  application_name: "finserpay-iphone-identity-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

async function readColumn() {
  const result = await client.query(
    `
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Credito'
        AND column_name = $1
      LIMIT 1
    `,
    [COLUMN_NAME]
  );

  return result.rows[0] || null;
}

function assertCompatibleColumn(column) {
  if (!column) {
    throw new Error(`No se pudo verificar la columna ${COLUMN_NAME}.`);
  }

  if (column.data_type !== "text" || column.is_nullable !== "YES") {
    throw new Error(
      `La columna ${COLUMN_NAME} existe con una definicion incompatible.`
    );
  }
}

try {
  await client.connect();

  const existingColumn = await readColumn();
  if (existingColumn) {
    assertCompatibleColumn(existingColumn);
    console.log(`Esquema iPhone listo: ${COLUMN_NAME} ya existe.`);
  } else {
    await client.query("BEGIN");

    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query(
        `
          ALTER TABLE public."Credito"
          ADD COLUMN IF NOT EXISTS "iphoneSelfieCedulaDataUrl" TEXT
        `
      );

      const createdColumn = await readColumn();
      assertCompatibleColumn(createdColumn);
      await client.query("COMMIT");
      console.log(`Esquema iPhone actualizado: ${COLUMN_NAME} fue creada.`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
} finally {
  await client.end().catch(() => undefined);
}
