import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema de amortizacion."
  );
}

const client = new Client({
  application_name: "finserpay-credit-amortization-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const statements = [
  'ALTER TABLE public."CreditoConfiguracion" ADD COLUMN IF NOT EXISTS "fianzaCuotaPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT 2.083333, ADD COLUMN IF NOT EXISTS "seguroCuotaPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT 0.03',
  'ALTER TABLE public."CreditoConfiguracionDocumento" ADD COLUMN IF NOT EXISTS "fianzaCuotaPorcentaje" DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS "seguroCuotaPorcentaje" DOUBLE PRECISION',
  'CREATE TABLE IF NOT EXISTS public."CreditoAmortizacion" ("id" SERIAL PRIMARY KEY, "creditoId" INTEGER NOT NULL, "calculoVersion" TEXT NOT NULL DEFAULT \'FRANCES_V1\', "frecuenciaPago" TEXT NOT NULL, "periodosPorAnio" INTEGER NOT NULL CHECK ("periodosPorAnio" > 0), "numeroCuotas" INTEGER NOT NULL CHECK ("numeroCuotas" > 0), "valorVenta" NUMERIC(20,6) NOT NULL, "cuotaInicial" NUMERIC(20,6) NOT NULL, "valorFinanciado" NUMERIC(20,6) NOT NULL, "tasaInteresEaPorcentaje" NUMERIC(18,12) NOT NULL, "tasaPeriodo" NUMERIC(18,12) NOT NULL, "fianzaCuotaPorcentaje" NUMERIC(18,12) NOT NULL, "seguroCuotaPorcentaje" NUMERIC(18,12) NOT NULL, "cuotaCreditoExacta" NUMERIC(20,6) NOT NULL, "cuotaFianzaExacta" NUMERIC(20,6) NOT NULL, "cuotaSeguroExacta" NUMERIC(20,6) NOT NULL, "cuotaTotalExacta" NUMERIC(20,6) NOT NULL, "cuotaComercial" NUMERIC(20,2) NOT NULL, "totalInteres" NUMERIC(20,6) NOT NULL, "totalFianza" NUMERIC(20,6) NOT NULL, "totalSeguro" NUMERIC(20,6) NOT NULL, "totalPagar" NUMERIC(20,6) NOT NULL, "parametrosSnapshot" JSONB NOT NULL, "checksum" TEXT NOT NULL, "aprobadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "CreditoAmortizacion_creditoId_fkey" FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id") ON DELETE CASCADE ON UPDATE CASCADE)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "CreditoAmortizacion_creditoId_key" ON public."CreditoAmortizacion" ("creditoId")',
  'CREATE INDEX IF NOT EXISTS "CreditoAmortizacion_checksum_idx" ON public."CreditoAmortizacion" ("checksum")',
  'CREATE INDEX IF NOT EXISTS "CreditoAmortizacion_createdAt_idx" ON public."CreditoAmortizacion" ("createdAt")',
  'CREATE TABLE IF NOT EXISTS public."CreditoAmortizacionCuota" ("id" SERIAL PRIMARY KEY, "amortizacionId" INTEGER NOT NULL, "numero" INTEGER NOT NULL CHECK ("numero" > 0), "fechaVencimiento" DATE NOT NULL, "saldoInicial" NUMERIC(20,6) NOT NULL, "interes" NUMERIC(20,6) NOT NULL, "abonoCapital" NUMERIC(20,6) NOT NULL, "fianza" NUMERIC(20,6) NOT NULL, "seguro" NUMERIC(20,6) NOT NULL, "cuotaCredito" NUMERIC(20,6) NOT NULL, "cuotaTotal" NUMERIC(20,6) NOT NULL, "cuotaCobro" NUMERIC(20,2) NOT NULL, "saldoFinal" NUMERIC(20,6) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "CreditoAmortizacionCuota_amortizacionId_fkey" FOREIGN KEY ("amortizacionId") REFERENCES public."CreditoAmortizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE)',
  'ALTER TABLE public."CreditoAmortizacionCuota" ADD COLUMN IF NOT EXISTS "cuotaCobro" NUMERIC(20,2)',
  'UPDATE public."CreditoAmortizacionCuota" SET "cuotaCobro" = ROUND("cuotaTotal", 2) WHERE "cuotaCobro" IS NULL',
  'UPDATE public."CreditoAmortizacionCuota" installment SET "cuotaCobro" = ROUND(header."totalPagar" - COALESCE((SELECT SUM(previous."cuotaCobro") FROM public."CreditoAmortizacionCuota" previous WHERE previous."amortizacionId" = installment."amortizacionId" AND previous."numero" < installment."numero"), 0), 2) FROM public."CreditoAmortizacion" header WHERE header."id" = installment."amortizacionId" AND installment."numero" = header."numeroCuotas"',
  'ALTER TABLE public."CreditoAmortizacionCuota" ALTER COLUMN "cuotaCobro" SET NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "CreditoAmortizacionCuota_amortizacionId_numero_key" ON public."CreditoAmortizacionCuota" ("amortizacionId", "numero")',
  'CREATE INDEX IF NOT EXISTS "CreditoAmortizacionCuota_fechaVencimiento_idx" ON public."CreditoAmortizacionCuota" ("fechaVencimiento")',
];

const expectedColumns = [
  ["CreditoConfiguracion", "fianzaCuotaPorcentaje", "double precision", "NO"],
  ["CreditoConfiguracion", "seguroCuotaPorcentaje", "double precision", "NO"],
  ["CreditoConfiguracionDocumento", "fianzaCuotaPorcentaje", "double precision", "YES"],
  ["CreditoConfiguracionDocumento", "seguroCuotaPorcentaje", "double precision", "YES"],
  ["CreditoAmortizacion", "creditoId", "integer", "NO"],
  ["CreditoAmortizacion", "parametrosSnapshot", "jsonb", "NO"],
  ["CreditoAmortizacionCuota", "cuotaTotal", "numeric", "NO"],
  ["CreditoAmortizacionCuota", "cuotaCobro", "numeric", "NO"],
];

async function assertCompatibleSchema() {
  const result = await client.query(
    "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
    [
      [
        "CreditoConfiguracion",
        "CreditoConfiguracionDocumento",
        "CreditoAmortizacion",
        "CreditoAmortizacionCuota",
      ],
    ]
  );
  const columns = new Map(
    result.rows.map((row) => [
      row.table_name + "." + row.column_name,
      row,
    ])
  );

  for (const [table, column, dataType, nullable] of expectedColumns) {
    const actual = columns.get(table + "." + column);
    if (
      !actual ||
      actual.data_type !== dataType ||
      actual.is_nullable !== nullable
    ) {
      throw new Error(
        "Definicion incompatible en " + table + "." + column + "."
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
      "SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-amortization-schema'))"
    );
    for (const statement of statements) {
      await client.query(statement);
    }
    await assertCompatibleSchema();
    await client.query("COMMIT");
    console.log("Esquema de amortizacion preparado correctamente.");
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
    "No se pudo preparar el esquema de amortizacion" +
      (code ? " (" + code + ")" : "") +
      "."
  );
} finally {
  await client.end().catch(() => undefined);
}
