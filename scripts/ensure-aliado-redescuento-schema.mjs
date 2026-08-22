import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el redescuento por plataforma."
  );
}

const client = new Client({
  application_name: "finserpay-aliado-redescuento-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const expectedColumns = [
  "redescuentoAndroidPorcentaje",
  "redescuentoIphonePorcentaje",
];

async function assertCompatibleSchema() {
  const result = await client.query(
    `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Aliado'
        AND column_name = ANY($1::text[])
    `,
    [expectedColumns]
  );
  const columns = new Map(result.rows.map((row) => [row.column_name, row]));

  for (const columnName of expectedColumns) {
    const column = columns.get(columnName);
    if (
      !column ||
      column.data_type !== "double precision" ||
      column.is_nullable !== "NO"
    ) {
      throw new Error(
        `Definicion incompatible en Aliado.${columnName}.`
      );
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
      "SELECT pg_advisory_xact_lock(hashtext('finserpay-aliado-redescuento-schema'))"
    );
    await client.query(`
      ALTER TABLE public."Aliado"
        ADD COLUMN IF NOT EXISTS "redescuentoPorcentaje"
          DOUBLE PRECISION NOT NULL DEFAULT 10,
        ADD COLUMN IF NOT EXISTS "redescuentoAndroidPorcentaje"
          DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS "redescuentoIphonePorcentaje"
          DOUBLE PRECISION
    `);
    await client.query(`
      UPDATE public."Aliado"
      SET
        "redescuentoAndroidPorcentaje" = COALESCE(
          "redescuentoAndroidPorcentaje",
          "redescuentoPorcentaje",
          10
        ),
        "redescuentoIphonePorcentaje" = COALESCE(
          "redescuentoIphonePorcentaje",
          "redescuentoPorcentaje",
          10
        )
      WHERE
        "redescuentoAndroidPorcentaje" IS NULL
        OR "redescuentoIphonePorcentaje" IS NULL
    `);
    await client.query(`
      ALTER TABLE public."Aliado"
        ALTER COLUMN "redescuentoAndroidPorcentaje" SET DEFAULT 10,
        ALTER COLUMN "redescuentoAndroidPorcentaje" SET NOT NULL,
        ALTER COLUMN "redescuentoIphonePorcentaje" SET DEFAULT 10,
        ALTER COLUMN "redescuentoIphonePorcentaje" SET NOT NULL
    `);
    await assertCompatibleSchema();
    await client.query("COMMIT");
    console.log("Redescuento por plataforma preparado correctamente.");
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
    "No se pudo preparar el redescuento por plataforma" +
      (code ? " (" + code + ")" : "") +
      "."
  );
} finally {
  await client.end().catch(() => undefined);
}
