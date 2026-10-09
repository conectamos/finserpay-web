import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

async function annulmentTriggerStatements() {
  const source = await readFile(
    new URL("../scripts/ensure-ally-payments-schema.mjs", import.meta.url),
    "utf8"
  );
  const marker = "const statements = ";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const arrayStart = start + marker.length;
  const arrayEnd = source.indexOf("\n];", arrayStart);
  assert.notEqual(arrayEnd, -1);
  const statements = runInNewContext(
    `(${source.slice(arrayStart, arrayEnd + 2)})`
  );

  return [
    statements.find((statement) =>
      statement.includes('try_parse_ally_payment_annulment_timestamp')
    ),
    statements.find((statement) =>
      statement.includes('capture_paid_credit_annulment_adjustment')
    ),
  ];
}

test("el trigger de compatibilidad captura una anulacion pagada una sola vez", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE public."Aliado" (
        "id" INTEGER PRIMARY KEY,
        "nombre" TEXT NOT NULL
      );
      CREATE TABLE public."Sede" (
        "id" INTEGER PRIMARY KEY,
        "nombre" TEXT NOT NULL
      );
      CREATE TABLE public."Credito" (
        "id" INTEGER PRIMARY KEY,
        "estado" TEXT NOT NULL,
        "sedeId" INTEGER NOT NULL,
        "observacionAdmin" TEXT,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE public."LiquidacionAliado" (
        "id" INTEGER PRIMARY KEY,
        "aliadoId" INTEGER NOT NULL,
        "estado" TEXT NOT NULL
      );
      CREATE TABLE public."LiquidacionAliadoCredito" (
        "id" INTEGER PRIMARY KEY,
        "liquidacionId" INTEGER NOT NULL,
        "creditoId" INTEGER NOT NULL,
        "folio" TEXT NOT NULL,
        "clienteNombre" TEXT NOT NULL,
        "clienteDocumento" TEXT NOT NULL,
        "imei" TEXT NOT NULL,
        "equipo" TEXT NOT NULL,
        "plataforma" TEXT NOT NULL,
        "valorPagar" NUMERIC(20,2) NOT NULL,
        "estado" TEXT NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE public."AjusteAnulacionCreditoAliado" (
        "id" SERIAL PRIMARY KEY,
        "creditoId" INTEGER NOT NULL UNIQUE,
        "liquidacionCreditoOrigenId" INTEGER NOT NULL UNIQUE,
        "aliadoId" INTEGER NOT NULL,
        "aliadoNombre" VARCHAR(180) NOT NULL,
        "fechaAnulacion" TIMESTAMP(3) NOT NULL,
        "fechaAnulacionFuente" VARCHAR(32) NOT NULL,
        "folio" VARCHAR(80) NOT NULL,
        "clienteNombre" VARCHAR(180) NOT NULL,
        "clienteDocumento" VARCHAR(80) NOT NULL,
        "imei" VARCHAR(80) NOT NULL,
        "equipo" VARCHAR(240) NOT NULL,
        "plataforma" VARCHAR(16) NOT NULL,
        "sedeId" INTEGER NOT NULL,
        "sedeNombre" VARCHAR(180) NOT NULL,
        "liquidacionOrigenId" INTEGER NOT NULL,
        "valorDescuento" NUMERIC(20,2) NOT NULL,
        "motivo" VARCHAR(500) NOT NULL,
        "creadoPorUsuarioId" INTEGER,
        "creadoPorNombre" VARCHAR(160) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO public."Aliado" VALUES (7, 'ALIADO QA');
      INSERT INTO public."Sede" VALUES (4, 'SEDE QA');
      INSERT INTO public."Credito" ("id", "estado", "sedeId")
        VALUES (9901, 'FINALIZADO', 4);
      INSERT INTO public."LiquidacionAliado" VALUES (220, 7, 'PAGADA');
      INSERT INTO public."LiquidacionAliadoCredito" (
        "id", "liquidacionId", "creditoId", "folio", "clienteNombre",
        "clienteDocumento", "imei", "equipo", "plataforma", "valorPagar",
        "estado"
      ) VALUES (
        310, 220, 9901, 'QA-ANULADO-001',
        'CLIENTE QA', '900100200', '350000000000001',
        'IPHONE QA', 'IPHONE', 1125000, 'PAGADO'
      );
    `);

    const statements = await annulmentTriggerStatements();
    assert.ok(statements.every(Boolean));
    for (const statement of statements) await db.exec(statement);

    await db.exec(`
      UPDATE public."Credito"
      SET
        "estado" = 'ANULADO',
        "observacionAdmin" = '[2026-11-02T14:15:00.000Z] ANULACION: Solicitud aprobada'
      WHERE "id" = 9901;
    `);

    const first = await db.query(`
      SELECT "creditoId", "aliadoId", "clienteDocumento", "valorDescuento",
        "fechaAnulacionFuente", "motivo", "liquidacionOrigenId"
      FROM public."AjusteAnulacionCreditoAliado"
    `);
    assert.deepEqual(first.rows.map((row) => ({
      ...row,
      valorDescuento: Number(row.valorDescuento),
    })), [{
      creditoId: 9901,
      aliadoId: 7,
      clienteDocumento: "900100200",
      valorDescuento: 1_125_000,
      fechaAnulacionFuente: "TRIGGER_BASE_DATOS",
      motivo: "Solicitud aprobada",
      liquidacionOrigenId: 220,
    }]);

    await db.exec(`
      UPDATE public."Credito" SET "estado" = 'FINALIZADO' WHERE "id" = 9901;
      UPDATE public."Credito" SET "estado" = 'ANULADO' WHERE "id" = 9901;
    `);
    const count = await db.query(
      'SELECT COUNT(*)::int AS total FROM public."AjusteAnulacionCreditoAliado"'
    );
    assert.equal(count.rows[0].total, 1);

    const timestamps = await db.query(`
      SELECT
        public."try_parse_ally_payment_annulment_timestamp"(
          '2026-11-02T14:15:00.000Z'
        ) IS NOT NULL AS valid,
        public."try_parse_ally_payment_annulment_timestamp"(
          '2026-99-99T99:99:99Z'
        ) IS NULL AS invalid
    `);
    assert.deepEqual(timestamps.rows, [{ valid: true, invalid: true }]);
  } finally {
    await db.close();
  }
});
