import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { calculateAllySettlementBalance } from "../lib/ally-payments-core.ts";
import {
  allyPaymentCentralCollectionAdjustmentSchemaStatements,
  allyPaymentCentralCollectionAdjustmentValidationStatements,
} from "../scripts/ally-payment-central-collection-adjustment-schema.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

async function installSchema(database) {
  for (const statement of allyPaymentCentralCollectionAdjustmentSchemaStatements) {
    await database.exec(statement);
  }
  for (const statement of allyPaymentCentralCollectionAdjustmentValidationStatements) {
    await database.exec(statement);
  }
}

async function createDatabaseFixture() {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE public."Aliado" (
      "id" INTEGER PRIMARY KEY,
      "codigo" TEXT NOT NULL,
      "nombre" TEXT NOT NULL
    );
    CREATE TABLE public."Sede" (
      "id" INTEGER PRIMARY KEY,
      "aliadoId" INTEGER,
      "nombre" TEXT NOT NULL
    );
    CREATE TABLE public."Rol" (
      "id" INTEGER PRIMARY KEY,
      "nombre" TEXT NOT NULL
    );
    CREATE TABLE public."Usuario" (
      "id" INTEGER PRIMARY KEY,
      "nombre" TEXT NOT NULL,
      "usuario" TEXT NOT NULL,
      "rolId" INTEGER NOT NULL,
      "sedeId" INTEGER NOT NULL
    );
    CREATE TABLE public."CreditoAbono" (
      "id" INTEGER PRIMARY KEY,
      "creditoId" INTEGER NOT NULL,
      "usuarioId" INTEGER NOT NULL,
      "sedeId" INTEGER NOT NULL,
      "fechaAbono" TIMESTAMP(3) NOT NULL,
      "metodoPago" TEXT NOT NULL,
      "valor" NUMERIC(20,2) NOT NULL,
      "estado" TEXT NOT NULL
    );
    CREATE TABLE public."Credito" (
      "id" INTEGER PRIMARY KEY
    );
    CREATE TABLE public."LiquidacionAliado" (
      "id" INTEGER PRIMARY KEY,
      "aliadoId" INTEGER NOT NULL,
      "estado" TEXT NOT NULL,
      "totalValorVenta" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "totalCreditoAutorizado" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "totalCuotaInicial" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "totalIntermediacion" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "totalPagar" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "totalRecaudosAliado" NUMERIC(20,2),
      "numeroAjustesAnulacion" INTEGER NOT NULL DEFAULT 0,
      "totalAjustesAnulacion" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "saldoNeto" NUMERIC(20,2),
      "direccionSaldo" VARCHAR(32)
    );
    CREATE TABLE public."LiquidacionAliadoRecaudo" (
      "id" INTEGER PRIMARY KEY,
      "liquidacionId" INTEGER NOT NULL,
      "abonoId" INTEGER NOT NULL,
      "creditoId" INTEGER NOT NULL,
      "sedeId" INTEGER NOT NULL,
      "fechaAbono" TIMESTAMP(3) NOT NULL,
      "folio" TEXT NOT NULL,
      "clienteNombre" TEXT NOT NULL,
      "clienteDocumento" TEXT NOT NULL,
      "sedeNombre" TEXT NOT NULL,
      "metodoPago" TEXT NOT NULL,
      "valor" NUMERIC(20,2) NOT NULL,
      "estado" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO public."Aliado" ("id", "codigo", "nombre") VALUES
      (1, 'FINSERPAY', 'FINSER PAY'),
      (2, 'JG', 'JG COMPANY'),
      (3, 'OTRO', 'OTRO ALIADO');
    INSERT INTO public."Sede" ("id", "aliadoId", "nombre") VALUES
      (10, 1, 'ADMIN FINSER PAY'),
      (20, 2, 'JGPrincipal'),
      (30, 3, 'Sede otro aliado');
    INSERT INTO public."Rol" ("id", "nombre") VALUES
      (1, 'ADMIN'),
      (2, 'VENDEDOR');
    INSERT INTO public."Usuario" ("id", "nombre", "usuario", "rolId", "sedeId") VALUES
      (1, 'Administrador', 'admin', 1, 10),
      (2, 'Usuario aliado', 'aliado.jg', 2, 20);
    INSERT INTO public."Credito" ("id") VALUES (4100), (4101);

    INSERT INTO public."LiquidacionAliado" (
      "id", "aliadoId", "estado", "totalPagar", "totalRecaudosAliado",
      "numeroAjustesAnulacion", "totalAjustesAnulacion", "saldoNeto", "direccionSaldo"
    ) VALUES
      (100, 2, 'PAGADA', 500000, 110000.37, 0, 0, 389999.63, 'PAGO_ALIADO'),
      (200, 2, 'PAGADA', 0, 0, 0, 0, 0, 'SALDO_CERO'),
      (201, 2, 'PAGADA', 0, 0, 0, 0, 0, 'SALDO_CERO'),
      (300, 3, 'PAGADA', 0, 0, 0, 0, 0, 'SALDO_CERO');

    INSERT INTO public."CreditoAbono" (
      "id", "creditoId", "usuarioId", "sedeId", "fechaAbono",
      "metodoPago", "valor", "estado"
    ) VALUES
      (1574, 4100, 1, 20, '2026-10-08T12:00:00', 'OTRO', 110000.37, 'ACTIVO'),
      (1575, 4101, 1, 20, '2026-10-08T13:00:00', 'OTRO', 99999.99, 'ACTIVO');

    INSERT INTO public."LiquidacionAliadoRecaudo" (
      "id", "liquidacionId", "abonoId", "creditoId", "sedeId", "fechaAbono",
      "folio", "clienteNombre", "clienteDocumento", "sedeNombre", "metodoPago",
      "valor", "estado"
    ) VALUES
      (500, 100, 1574, 4100, 20, '2026-10-08T12:00:00', 'FC-1574',
       'MORENO MARIN LINA LUZ', '53068434', 'JGPrincipal', 'OTRO', 110000.37, 'DESCONTADO'),
      (501, 100, 1575, 4101, 20, '2026-10-08T13:00:00', 'FC-1575',
       'CLIENTE NO OBJETIVO', '99999999', 'JGPrincipal', 'OTRO', 99999.99, 'DESCONTADO');
  `);
  return database;
}

test("el ajuste central se suma al saldo y revierte exactamente el recaudo descontado", () => {
  assert.deepEqual(
    calculateAllySettlementBalance(0, 110_000, 0, 110_000),
    {
      totalPagarCreditos: 0,
      totalRecaudosAliado: 110_000,
      totalAjustesAnulacion: 0,
      totalAjustesRecaudoCentral: 110_000,
      saldoNeto: 0,
      direccionSaldo: "SALDO_CERO",
      valorPagarAliado: 0,
      valorConsignarAliado: 0,
    }
  );

  const onlyAdjustment = calculateAllySettlementBalance(0, 0, 0, 110_000);
  assert.equal(onlyAdjustment.saldoNeto, 110_000);
  assert.equal(onlyAdjustment.direccionSaldo, "PAGO_ALIADO");
  assert.equal(onlyAdjustment.valorPagarAliado, 110_000);
  assert.equal(onlyAdjustment.valorConsignarAliado, 0);
});

test("el esquema siembra solo el abono 1574 desde el snapshot y no duplica ni permite mutarlo", async () => {
  const database = await createDatabaseFixture();
  try {
    await installSchema(database);

    const first = await database.query(`
      SELECT "abonoId", "liquidacionRecaudoOrigenId", "creditoId", "aliadoId",
        "liquidacionOrigenId", "valorAjuste", "usuarioRecaudoId",
        "usuarioRecaudoLogin", "fuente"
      FROM public."AjusteRecaudoCentralAliado"
      ORDER BY "id"
    `);
    assert.deepEqual(plain(first.rows).map((row) => ({
      ...row,
      valorAjuste: Number(row.valorAjuste),
    })), [{
      abonoId: 1574,
      liquidacionRecaudoOrigenId: 500,
      creditoId: 4100,
      aliadoId: 2,
      liquidacionOrigenId: 100,
      valorAjuste: 110000.37,
      usuarioRecaudoId: 1,
      usuarioRecaudoLogin: "admin",
      fuente: "CORRECCION_DIRIGIDA_ABONO",
    }]);

    await installSchema(database);
    const count = await database.query(`
      SELECT COUNT(*)::int AS total
      FROM public."AjusteRecaudoCentralAliado"
    `);
    assert.equal(count.rows[0].total, 1, "El predeploy puede reintentarse sin duplicar el ajuste.");

    const original = await database.query(`
      SELECT "valor", "estado"
      FROM public."LiquidacionAliadoRecaudo"
      WHERE "abonoId" = 1574
    `);
    assert.deepEqual(plain(original.rows).map((row) => ({
      ...row,
      valor: Number(row.valor),
    })), [{ valor: 110000.37, estado: "DESCONTADO" }]);

    await assert.rejects(
      database.exec('UPDATE public."AjusteRecaudoCentralAliado" SET "motivo" = \'Cambio\' WHERE "abonoId" = 1574'),
      /append-only|inmutable|IMMUTABLE/i
    );
    await assert.rejects(
      database.exec('DELETE FROM public."AjusteRecaudoCentralAliado" WHERE "abonoId" = 1574'),
      /append-only|inmutable|IMMUTABLE/i
    );
    await assert.rejects(
      database.exec(
        'TRUNCATE public."AjusteRecaudoCentralAliado", public."LiquidacionAliadoAjusteRecaudoCentral"'
      ),
      /append-only|inmutable|IMMUTABLE/i
    );
  } finally {
    await database.close();
  }
});

test("la aplicación solo acepta otra liquidación del mismo aliado y el valor exacto del origen", async () => {
  const database = await createDatabaseFixture();
  try {
    await installSchema(database);
    const adjustment = await database.query(`
      SELECT "id" FROM public."AjusteRecaudoCentralAliado" WHERE "abonoId" = 1574
    `);
    const adjustmentId = adjustment.rows[0].id;
    const insert = (settlementId, value, selectedAdjustmentId = adjustmentId) => database.query(`
      INSERT INTO public."LiquidacionAliadoAjusteRecaudoCentral" (
        "liquidacionId", "ajusteId", "valorAjuste", "estado"
      ) VALUES ($1, $2, $3, 'ACREDITADO')
    `, [settlementId, selectedAdjustmentId, value]);

    await assert.rejects(insert(200, "110000.37", 999999), /ALLY_PAYMENT_CENTRAL_COLLECTION_ADJUSTMENT_NOT_FOUND/);
    await assert.rejects(insert(999999, "110000.37"), /ALLY_PAYMENT_CENTRAL_COLLECTION_SETTLEMENT_NOT_FOUND/);
    await assert.rejects(insert(100, "110000.37"), /ALLY_PAYMENT_CENTRAL_COLLECTION_SAME_SETTLEMENT/);
    await assert.rejects(insert(300, "110000.37"), /ALLY_PAYMENT_CENTRAL_COLLECTION_ALLY_MISMATCH/);
    await assert.rejects(insert(200, "110000.36"), /ALLY_PAYMENT_CENTRAL_COLLECTION_VALUE_MISMATCH/);

    await insert(200, "110000.37");
    await assert.rejects(
      insert(201, "110000.37"),
      /unique|duplic|LiquidacionAliadoAjusteRecaudoCentral_ajusteId_key/i
    );
    await assert.rejects(
      database.exec('UPDATE public."LiquidacionAliadoAjusteRecaudoCentral" SET "valorAjuste" = 1'),
      /append-only|inmutable|IMMUTABLE/i
    );
    await assert.rejects(
      database.exec('DELETE FROM public."LiquidacionAliadoAjusteRecaudoCentral"'),
      /append-only|inmutable|IMMUTABLE/i
    );
    await assert.rejects(
      database.exec('TRUNCATE public."LiquidacionAliadoAjusteRecaudoCentral"'),
      /append-only|inmutable|IMMUTABLE/i
    );
  } finally {
    await database.close();
  }
});

test("la previsualización y confirmación incluyen el ajuste en fingerprint, bloqueo y snapshot", async () => {
  const source = await readFile(
    new URL("../lib/ally-payments.ts", import.meta.url),
    "utf8"
  );
  const previewStart = source.indexOf("function previewFingerprint");
  const requestStart = source.indexOf("function requestFingerprint", previewStart);
  const createStart = source.indexOf("export async function createAllyPayment");
  assert.ok(previewStart >= 0 && requestStart > previewStart && createStart > requestStart);
  const previewFingerprint = source.slice(previewStart, requestStart);
  const confirmation = source.slice(createStart);

  assert.match(source, /loadPendingAllyPaymentCentralCollectionAdjustments/);
  assert.match(source, /totalAllyPaymentCentralCollectionAdjustments/);
  assert.match(previewFingerprint, /ajustesRecaudoCentral/);
  assert.match(previewFingerprint, /ajusteId/);
  assert.match(previewFingerprint, /abonoId/);
  assert.match(previewFingerprint, /liquidacionOrigenId/);
  assert.match(previewFingerprint, /valorAjuste/);

  assert.match(
    confirmation,
    /loadPendingAllyPaymentCentralCollectionAdjustments[\s\S]*?allyId[\s\S]*?lock:\s*true/
  );
  assert.match(
    confirmation,
    /!ajustesRecaudoCentral\.length/
  );
  assert.match(
    confirmation,
    /previewFingerprint\([\s\S]*?ajustesRecaudoCentral[\s\S]*?\)/
  );
  assert.match(
    confirmation,
    /calculateAllySettlementBalance\([\s\S]*?totalAllyPaymentCentralCollectionAdjustments\(ajustesRecaudoCentral\)/
  );
  assert.match(confirmation, /numeroAjustesRecaudoCentral:\s*ajustesRecaudoCentral\.length/);
  assert.match(
    confirmation,
    /totalAjustesRecaudoCentral:\s*moneyForDatabase\(\s*balance\.totalAjustesRecaudoCentral/
  );
  assert.match(
    confirmation,
    /ajustesRecaudoCentral:\s*\{[\s\S]*?create:\s*ajustesRecaudoCentral\.map[\s\S]*?valorAjuste:[\s\S]*?estado:\s*"ACREDITADO"[\s\S]*?ajuste:\s*\{\s*connect:/
  );
});
