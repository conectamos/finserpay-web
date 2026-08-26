import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema de solicitudes."
  );
}

const client = new Client({
  application_name: "finserpay-solicitudes-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const statements = [
  `
    CREATE TABLE IF NOT EXISTS public."CreditoBorrador" (
      "id" SERIAL PRIMARY KEY,
      "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
      "usuarioId" INTEGER NOT NULL,
      "vendedorId" INTEGER,
      "sedeId" INTEGER NOT NULL,
      "currentStep" INTEGER NOT NULL DEFAULT 1,
      "clienteNombre" TEXT,
      "clienteDocumento" TEXT,
      "clienteTelefono" TEXT,
      "imei" TEXT,
      "plataforma" TEXT,
      "dataCreditoAssessmentId" UUID,
      "creditoId" INTEGER,
      "closedReason" TEXT,
      "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "closedAt" TIMESTAMPTZ,
      "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days'),
      "desistedByUserId" INTEGER,
      "desistedBySellerId" INTEGER
    )
  `,
  `
    ALTER TABLE public."CreditoBorrador"
      ADD COLUMN IF NOT EXISTS "plataforma" TEXT,
      ADD COLUMN IF NOT EXISTS "dataCreditoAssessmentId" UUID,
      ADD COLUMN IF NOT EXISTS "creditoId" INTEGER,
      ADD COLUMN IF NOT EXISTS "closedReason" TEXT,
      ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "desistedByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "desistedBySellerId" INTEGER
  `,
  `
    ALTER TABLE public."CreditoBorrador"
      ALTER COLUMN "expiresAt" SET DEFAULT (NOW() + INTERVAL '15 days')
  `,
  `
    UPDATE public."CreditoBorrador"
    SET "expiresAt" = "createdAt" + INTERVAL '15 days'
    WHERE "estado" = 'ABIERTO' AND "expiresAt" IS NULL
  `,
  `CREATE INDEX IF NOT EXISTS "CreditoBorrador_expiresAt_idx" ON public."CreditoBorrador" ("expiresAt")`,
  `CREATE INDEX IF NOT EXISTS "CreditoBorrador_assessment_idx" ON public."CreditoBorrador" ("dataCreditoAssessmentId")`,
  `CREATE INDEX IF NOT EXISTS "CreditoBorrador_credito_idx" ON public."CreditoBorrador" ("creditoId")`,
  `
    CREATE INDEX IF NOT EXISTS "CreditoBorrador_document_idx"
    ON public."CreditoBorrador" ((regexp_replace(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g')))
  `,
  `
    CREATE INDEX IF NOT EXISTS "Credito_document_idx"
    ON public."Credito" ((regexp_replace(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g')))
  `,
  `
    CREATE INDEX IF NOT EXISTS "CreditoBorrador_active_document_idx"
    ON public."CreditoBorrador" ((regexp_replace(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g')))
    WHERE "estado" = 'ABIERTO'
  `,
  `
    CREATE INDEX IF NOT EXISTS "CreditoBorrador_active_imei_idx"
    ON public."CreditoBorrador" ((regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g')))
    WHERE "estado" = 'ABIERTO'
  `,
];

const expectedColumns = new Map([
  ["plataforma", "text"],
  ["dataCreditoAssessmentId", "uuid"],
  ["creditoId", "integer"],
  ["closedReason", "text"],
  ["expiresAt", "timestamp with time zone"],
  ["desistedByUserId", "integer"],
  ["desistedBySellerId", "integer"],
]);

const expectedIndexes = new Set([
  "CreditoBorrador_expiresAt_idx",
  "CreditoBorrador_assessment_idx",
  "CreditoBorrador_credito_idx",
  "CreditoBorrador_document_idx",
  "CreditoBorrador_active_document_idx",
  "CreditoBorrador_active_imei_idx",
]);

const expectedCreditIndexes = new Set(["Credito_document_idx"]);

async function assertCompatibleSchema() {
  const columns = await client.query(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'CreditoBorrador'
    `
  );
  const actualColumns = new Map(
    columns.rows.map((row) => [row.column_name, row.data_type])
  );
  for (const [column, dataType] of expectedColumns) {
    if (actualColumns.get(column) !== dataType) {
      throw new Error(`Definicion incompatible en CreditoBorrador.${column}.`);
    }
  }

  const indexes = await client.query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'CreditoBorrador'
    `
  );
  const actualIndexes = new Set(indexes.rows.map((row) => row.indexname));
  for (const index of expectedIndexes) {
    if (!actualIndexes.has(index)) {
      throw new Error(`Indice faltante para solicitudes: ${index}.`);
    }
  }

  const creditIndexes = await client.query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'Credito'
    `
  );
  const actualCreditIndexes = new Set(
    creditIndexes.rows.map((row) => row.indexname)
  );
  for (const index of expectedCreditIndexes) {
    if (!actualCreditIndexes.has(index)) {
      throw new Error(`Indice faltante para solicitudes: ${index}.`);
    }
  }
}

try {
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('finserpay-solicitudes-schema'))"
    );
    for (const statement of statements) {
      await client.query(statement);
    }
    await assertCompatibleSchema();
    await client.query("COMMIT");
    console.log("Esquema de solicitudes preparado correctamente.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24)
      : "";
  throw new Error(
    "No se pudo preparar el esquema de solicitudes" +
      (code ? ` (${code})` : "") +
      "."
  );
} finally {
  await client.end().catch(() => undefined);
}
