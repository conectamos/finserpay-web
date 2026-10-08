import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const cache = new Map();
function load(file, dependencies = {}, useCache = true) {
  if (useCache && cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} };
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: loadedModule, exports: loadedModule.exports, Date, Object, Number, Set, String,
    Buffer, Request, Response, Intl,
    require(name) {
      if (name in dependencies) return dependencies[name];
      if (name === "node:crypto") return { createHash, randomUUID };
      if (name.startsWith("@/lib/")) return load(`${name.slice(2)}.ts`);
      if (name.startsWith(".")) return load(`${posix.normalize(posix.join(posix.dirname(file), name))}.ts`);
      throw new Error(`Unexpected dependency ${name}`);
    } }, { filename: file });
  if (useCache) cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const core = load("lib/approval-request-financial-correction-core.ts");
const clone = (value) => JSON.parse(JSON.stringify(value));
const config = {
  platform: "IPHONE", initialPaymentPercentage: 20, catalogBasePrice: null,
  iphoneMaxFinancedAmount: 3_200_000, maxFinancedAmount: 3_000_000, maxInstallments: 40,
  maxInstallmentAmount: 160_000, firstPaymentDateKey: "2026-10-17",
  financialSettings: { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24,
    fianzaTotalPorcentaje: 75, fianzaCuotaPorcentaje: 75 / 40, fianzaModalidad: "TOTAL_CREDITO",
    fianzaSource: "POLITICA", seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
    tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } },
};
const configVersion = "a".repeat(64);
const remissionPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGd8AAAAASUVORK5CYII=";
const payload = { valorEquipoTotal: "4000000", cuotaInicial: "1200000", plazoMeses: "40",
  clienteNombre: "PRUEBA DEMO", clienteDocumento: "123456789", clientePrimerApellido: "DEMO",
  clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", imei: "350000000000001", plataformaDispositivo: "IPHONE",
  equipoMarca: "IPHONE", equipoModelo: "PRUEBA", dataCreditoAssessmentId: "assessment-test",
  currentStep: 2, wizardStep: 2, fotoRemisionDataUrl: `data:image/png;base64,${remissionPng}`,
  fotoRemisionCapturedAt: "2026-10-08T15:00:00Z", fotoRemisionSource: "CORRECCION_ANALISTA_SOLICITUD",
  contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,IDENTITY", financialTermsSeal: { old: true } };
function input(values, before = payload, expectedRevision = core.requestFinancialRevision(before), version = configVersion) {
  return core.parseRequestFinancialCorrection({ values, expectedValues: Object.fromEntries(
    core.REQUEST_FINANCIAL_FIELDS.map((field) => [field, String(before[field] ?? "")])),
    expectedRevision, expectedConfigVersion: version, reason: "Corrección acordada de la propuesta", confirmed: true });
}
function correction(values, before = payload) {
  return core.applyRequestFinancialCorrection(before, input(values, before), config, configVersion, "Analista de prueba",
    new Date("2026-10-08T16:00:00Z"));
}

test("calcula la cuota con amortización real y la oferta vigente", () => {
  const result = core.calculateRequestFinancialTerms(payload, config);
  const actual = load("lib/credit-amortization.ts").calculateFrenchAmortization({
    valorVenta: 4_000_000, cuotaInicial: 1_200_000, numeroCuotas: 40,
    ...config.financialSettings, frecuenciaPago: "QUINCENAL", fechaPrimerPago: config.firstPaymentDateKey,
  });
  assert.equal(result.preview.valorFinanciado, 2_800_000);
  assert.equal(result.preview.valorCuota, actual.cuotaCobro);
  assert.equal(result.preview.totalPagar, actual.montoTotal);
  const shorter = core.calculateRequestFinancialTerms({ ...payload, plazoMeses: "38" }, config);
  assert.equal(Number(shorter.values.fianzaCuotaPorcentaje), 75 / 38);
  assert.notEqual(shorter.preview.valorCuota, result.preview.valorCuota);
});
test("muestra la frecuencia de política y fecha automática sin depender del IMEI", () => {
  const result = core.calculateRequestFinancialTerms({ ...payload, valorEquipoTotal: "800000", cuotaInicial: "200000", imei: "", clienteNombre: "" }, {
    ...config, platform: "ANDROID", maxInstallmentAmount: null,
    financialSettings: { ...config.financialSettings, frecuenciaPago: "MENSUAL" }, firstPaymentDateKey: "2026-11-02",
  });
  assert.equal(result.preview.frecuenciaPago, "MENSUAL");
  assert.equal(result.preview.fechaPrimerPago, "2026-11-02");
});
test("rechaza cuota arbitraria, falta de confirmación y baseline incompleto", () => {
  for (const values of [{ valorCuota: "100" }, { frecuenciaPago: "SEMANAL" }, { imei: "350000000000002" }])
    assert.throws(() => input(values), { code: "INVALID_FIELDS" });
  const parsed = input({ cuotaInicial: "1300000" });
  assert.throws(() => core.parseRequestFinancialCorrection({ ...parsed, confirmed: false }), { code: "CONFIRMATION_REQUIRED" });
  assert.throws(() => core.parseRequestFinancialCorrection({ ...parsed, expectedValues: { cuotaInicial: "1200000" } }), { code: "INVALID_FIELDS" });
});
test("aplica límites de precalificación, inicial y cuota y enteros válidos", () => {
  for (const values of [{ cuotaInicial: "0" }, { cuotaInicial: "4000000" }, { plazoMeses: "41" },
    { plazoMeses: "1" }, { valorEquipoTotal: "Infinity" }, { valorEquipoTotal: "4e6" }, { cuotaInicial: "1200000.5" }])
    assert.throws(() => correction(values));
  assert.throws(() => core.calculateRequestFinancialTerms(payload, {
    ...config, maxFinancedAmount: 2_000_000,
  }), { code: "INITIAL_BELOW_MINIMUM" });
  assert.throws(() => core.calculateRequestFinancialTerms(payload, {
    ...config, financialSettings: { ...config.financialSettings, tasaInteresEa: 17.84 },
  }), { code: "DATACREDITO_FINANCIAL_TERMS_OUTDATED" });
});
test("snapshot de todos los parámetros evita confirmar una cuota no revisada", () => {
  const reviewed = input({ cuotaInicial: "1300000" });
  for (const change of [{ plazoMeses: "38" }, { valorEquipoTotal: "3900000" }, { analystFinancialRevision: 1 }])
    assert.throws(() => core.applyRequestFinancialCorrection({ ...payload, ...change }, reviewed,
      config, configVersion, "Analista"), { code: "REQUEST_CHANGED" });
  assert.throws(() => core.applyRequestFinancialCorrection(payload, reviewed, config, "b".repeat(64), "Analista"), { code: "REQUEST_CHANGED" });
});
test("metadata conserva identidad/equipo/avance e invalida solo plan y remisión", () => {
  const result = correction({ cuotaInicial: "1300000" });
  assert.equal(result.revision, 1);
  for (const field of ["clienteDocumento", "clienteNombre", "imei", "wizardStep", "contratoCedulaFrenteDataUrl"])
    assert.deepEqual(result.payload[field], payload[field]);
  assert.equal("financialTermsSeal" in result.payload, false);
  assert.equal("fotoRemisionDataUrl" in result.payload, false);
  assert.equal(result.payload.analystFinancialCorrection.actorName, "Analista de prueba");
  assert.equal(result.payload.analystFinancialCorrection.updatedAt, "2026-10-08T16:00:00.000Z");
  assert.equal(Object.keys(result.payload.analystFinancialCorrection.values).some((key) => /DataUrl/.test(key)), false);
});
test("autosave atrasado conserva corrección, limpia remisión vieja y no inventa seal", () => {
  const corrected = correction({ cuotaInicial: "1300000" }).payload;
  const saved = core.preserveAnalystFinancialCorrectionAutosave(corrected, { ...payload, clienteTelefono: "3101234567", analystFinancialRevision: 0 });
  assert.equal(saved.cuotaInicial, "1300000");
  assert.equal(saved.clienteTelefono, "3101234567");
  assert.equal("fotoRemisionDataUrl" in saved, false);
  assert.equal("financialTermsSeal" in saved, false);
  const acknowledged = core.preserveAnalystFinancialCorrectionAutosave(corrected, {
    ...saved, analystFinancialRevision: 1, cuotaInicial: "1400000", fotoRemisionDataUrl: "data:image/jpeg;base64,NEW", financialTermsSeal: { forged: true },
  });
  assert.equal(acknowledged.cuotaInicial, "1400000");
  assert.equal(acknowledged.fotoRemisionDataUrl, "data:image/jpeg;base64,NEW");
  assert.equal("financialTermsSeal" in acknowledged, false);
  const signed = core.preserveAnalystFinancialCorrectionAutosave({ ...corrected, financialTermsSeal: { canonical: true } }, { ...saved, financialTermsSeal: { old: true } });
  assert.deepEqual(clone(signed.financialTermsSeal), { canonical: true });
  const noRevision = core.preserveAnalystFinancialCorrectionAutosave({}, { analystFinancialRevision: 8, analystFinancialCorrection: { forged: true } });
  assert.equal("analystFinancialCorrection" in noRevision, false);
});

test("SQL real: cambios y auditoría atómicos, y bloqueos de firma/cierre/versiones", async (t) => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (1,5);
    CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY,"estado" TEXT NOT NULL,
      "creditoId" INTEGER,"usuarioId" INTEGER,"vendedorId" INTEGER,"sedeId" INTEGER,
      "clienteDocumento" TEXT,"payload" JSONB NOT NULL,"currentStep" INTEGER DEFAULT 2,
      "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"expiresAt" TIMESTAMPTZ);
    CREATE TABLE "FirmaSeguroProcess" ("id" INTEGER,"draftId" INTEGER,"status" TEXT);
    CREATE TABLE "FirmaSeguroDraftDispatch" ("id" INTEGER,"draftId" INTEGER,"status" TEXT);
    CREATE TABLE "ApprovalOperationalAction" ("id" UUID,"targetKind" TEXT,"targetId" INTEGER,"eventType" TEXT,
      "actorUserId" INTEGER,"actorName" TEXT,"reason" TEXT,"beforeContact" JSONB,"afterContact" JSONB,"status" TEXT,
      "evidenceMime" TEXT,"evidenceName" TEXT,"evidenceData" BYTEA,"evidenceSha256" TEXT);`);
  const trace = [];
  let policyMax = 3_000_000;
  const settings = { ...config.financialSettings, cuotaInicialPorcentaje: 20, iphoneTopeFinanciado: 3_200_000,
    iphoneTopeCuota: 160_000, plazoCuotas: 40, plazoMaximoCuotas: 40 };
  class CreditValidationError extends Error {}
  const service = load("lib/approval-request-financial-correction.ts", {
    "server-only": {}, "node:crypto": { createHash, randomUUID },
    "@/lib/prisma": { default: { $transaction: (callback) => pg.transaction((db) => callback({
      $queryRawUnsafe: async (sql, ...params) => (await db.query(sql, params)).rows,
      $executeRawUnsafe: async (sql, ...params) => (await db.query(sql, params)).affectedRows,
    })) } },
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
    "@/lib/solicitudes-storage": { ensureSolicitudSchema: async () => {} },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {}, lockSolicitudOperationMutation: async (_db, id) => trace.push(["operation", id]) },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {}, lockVeriffDraftAttempts: async (_db, id) => trace.push(["identity", id]) },
    "@/lib/equipment-catalog": { findEquipmentCatalogItem: async () => null, findEquipmentCatalogItemById: async () => null },
    "@/lib/credit-settings": { getEffectiveCreditSettings: async () => ({ globalSettings: settings }) },
    "@/lib/firmaseguro-draft-credit-builder": { CreditValidationError, getDraftDataCreditoOffer: async (row, saved) => {
      assert.equal(row.usuarioId, 15); assert.equal(row.sedeAliadoId, 5); assert.equal(saved.clienteDocumento, payload.clienteDocumento);
      return { assessmentId: "approved", policyRevisionId: "revision", financialSettings: config.financialSettings,
        initialPaymentPercentage: 20, suretyPercentage: 75, maxFinancedAmount: policyMax, installmentCount: 40, maxInstallmentAmount: 160_000 };
    } },
    "@/lib/datacredito/manual-credit-limits": { resolveDataCreditoManualCreditLimit: async ({ policyMaxFinancedAmount }) => ({ maxFinancedAmount: policyMaxFinancedAmount }) },
  }, false);
  let nextId = 0;
  const actor = { id: 21, nombre: "Analista SQL" };
  async function seed(extra = {}) {
    const id = ++nextId;
    await pg.query(`INSERT INTO "CreditoBorrador" ("id","estado","usuarioId","sedeId","clienteDocumento","payload","expiresAt")
      VALUES ($1,'ABIERTO',15,1,$2,$3::jsonb,'2300-01-01')`, [id, payload.clienteDocumento, JSON.stringify({ ...payload, ...extra })]);
    return id;
  }
  async function row(id) { return (await pg.query('SELECT * FROM "CreditoBorrador" WHERE "id"=$1', [id])).rows[0]; }
  async function audits(id) { return (await pg.query('SELECT * FROM "ApprovalOperationalAction" WHERE "targetId"=$1', [id])).rows; }
  async function reviewed(id, values) {
    const item = await service.getAnalystRequestFinancialCorrection(id);
    return input(values, (await row(id)).payload, item.revision, item.configVersion);
  }
  async function unchangedFailure(id, incoming, code) {
    const before = clone(await row(id));
    await assert.rejects(service.correctAnalystRequestFinancialConditions(id, incoming, actor), { code });
    assert.deepEqual(clone(await row(id)), before); assert.equal((await audits(id)).length, 0);
  }
  await t.test("guarda propuesta y ledger en la misma transacción, no cambia asesor/avance", async () => {
    const id = await seed(); const original = await row(id); const incoming = await reviewed(id, { cuotaInicial: "1300000" });
    const result = await service.correctAnalystRequestFinancialConditions(id, incoming, actor);
    const saved = await row(id);
    assert.equal(saved.payload.cuotaInicial, "1300000"); assert.equal(saved.payload.analystFinancialRevision, 1);
    for (const key of ["estado", "creditoId", "usuarioId", "sedeId", "clienteDocumento", "currentStep"]) assert.equal(saved[key], original[key]);
    assert.equal(result.preview.valorFinanciado, 2_700_000);
    assert.deepEqual(trace.slice(0, 2), [["operation", id], ["identity", id]]);
    const [audit] = await audits(id);
    assert.equal(audit.status, "FINANCIAL_CORRECTED"); assert.equal(audit.actorUserId, actor.id);
    assert.equal(audit.beforeContact.cuotaInicial, "1200000"); assert.equal(audit.afterContact.cuotaInicial, "1300000");
    assert.equal("fotoRemisionDataUrl" in saved.payload, false);
    assert.equal(audit.evidenceMime, "image/png"); assert.equal(audit.evidenceName, "remision-anterior.png");
    const priorBytes = Buffer.from(remissionPng, "base64");
    assert.equal(Buffer.from(audit.evidenceData).toString("base64"), remissionPng);
    assert.equal(audit.evidenceSha256, createHash("sha256").update(priorBytes).digest("hex"));
    assert.equal(audit.beforeContact.archivedRemission.source, payload.fotoRemisionSource);
    assert.equal(audit.beforeContact.archivedRemission.capturedAt, payload.fotoRemisionCapturedAt);
    assert.equal(JSON.stringify(audit.beforeContact).includes(remissionPng), false);
  });
  await t.test("firma histórica y reserva de envío bloquean incluso intentos fallidos", async () => {
    for (const table of ["FirmaSeguroProcess", "FirmaSeguroDraftDispatch"]) {
      const id = await seed(); const incoming = await reviewed(id, { cuotaInicial: "1300000" });
      await pg.query(`INSERT INTO "${table}" VALUES ($1,$1,'FAILED')`, [id]);
      await unchangedFailure(id, incoming, "REQUEST_LOCKED");
      const detail = await service.getAnalystRequestFinancialCorrection(id);
      assert.deepEqual(clone(detail.editableFields), []); assert.equal(detail.canManageContract, false);
    }
  });
  await t.test("cerrado, convertido, vencido o corrección pendiente no altera el historial", async () => {
    for (const state of ["closed", "converted", "expired", "pending"]) {
      const id = await seed(); const incoming = await reviewed(id, { cuotaInicial: "1300000" });
      if (state === "closed") await pg.query('UPDATE "CreditoBorrador" SET "estado"=\'CERRADO\' WHERE "id"=$1', [id]);
      if (state === "converted") await pg.query('UPDATE "CreditoBorrador" SET "creditoId"=99 WHERE "id"=$1', [id]);
      if (state === "expired") await pg.query('UPDATE "CreditoBorrador" SET "expiresAt"=\'1900-01-01\' WHERE "id"=$1', [id]);
      if (state === "pending") await pg.query('UPDATE "CreditoBorrador" SET "payload"="payload" || \'{"firmaSeguroFinancialCorrectionPending":true}\'::jsonb WHERE "id"=$1', [id]);
      await unchangedFailure(id, incoming, "REQUEST_LOCKED");
    }
  });
  await t.test("política cambiada y trabajo del asesor producen conflicto sin guardar", async () => {
    const id = await seed(); const incoming = await reviewed(id, { cuotaInicial: "1300000" });
    policyMax = 2_900_000;
    await unchangedFailure(id, incoming, "REQUEST_CHANGED"); policyMax = 3_000_000;
    await pg.query('UPDATE "CreditoBorrador" SET "payload"="payload" || \'{"plazoMeses":"38"}\'::jsonb WHERE "id"=$1', [id]);
    await unchangedFailure(id, incoming, "REQUEST_CHANGED");
  });
  await t.test("remisión corrupta no se borra sin poder conservarla", async () => {
    const id = await seed({ fotoRemisionDataUrl: "data:image/jpeg;base64,corrupt" });
    await unchangedFailure(id, await reviewed(id, { cuotaInicial: "1300000" }), "ARCHIVE_UNAVAILABLE");
  });
  await t.test("error del ledger revierte los nuevos valores", async () => {
    const id = await seed(); const incoming = await reviewed(id, { cuotaInicial: "1300000" }); const before = clone(await row(id));
    await pg.exec('ALTER TABLE "ApprovalOperationalAction" ADD CONSTRAINT "test_block" CHECK ("targetId" < 0) NOT VALID');
    await assert.rejects(service.correctAnalystRequestFinancialConditions(id, incoming, actor));
    assert.deepEqual(clone(await row(id)), before); assert.equal((await audits(id)).length, 0);
    await pg.exec('ALTER TABLE "ApprovalOperationalAction" DROP CONSTRAINT "test_block"');
  });
  await pg.close();
});

test("endpoint requiere analista nominal y rechaza enlaces compartidos", async () => {
  let analyst = null, shared, calls = 0;
  const route = load("app/api/aprobaciones/solicitudes/[id]/condiciones/route.ts", {
    "next/server": { NextResponse: { json: (value, options = {}) => Response.json(value, options) } },
    "@/lib/auth": { getNominalApprovalAnalystSessionUser: async () => analyst },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/credit-approval-http": { approvalErrorResponse: () => Response.json({ ok: false }, { status: 500 }), readApprovalRequest: (request) => request.json() },
    "@/lib/approval-request-financial-correction-core": core,
    "@/lib/approval-request-financial-correction": { parseFinancialCorrectionDraftId: (value) => Number(value.slice(2)),
      getAnalystRequestFinancialCorrection: async () => { calls++; return { values: {} }; },
      correctAnalystRequestFinancialConditions: async () => { calls++; return { values: {} }; } },
  }, false);
  const context = { params: Promise.resolve({ id: "D-1" }) };
  const request = new Request("https://example.test/api/aprobaciones/solicitudes/D-1/condiciones");
  assert.equal((await route.GET(request, context)).status, 401);
  analyst = { id: 22, nombre: "Analista" }; shared = { kind: "LINK" };
  assert.equal((await route.GET(request, context)).status, 401); assert.equal(calls, 0);
  shared = undefined; const allowed = await route.GET(request, context);
  assert.equal(allowed.status, 200); assert.match(allowed.headers.get("Cache-Control"), /no-store/); assert.equal(calls, 1);
  const unconfirmed = new Request(request.url, { method: "PATCH", body: JSON.stringify({ ...input({ cuotaInicial: "1300000" }), confirmed: false }) });
  assert.equal((await route.PATCH(unconfirmed, context)).status, 400); assert.equal(calls, 1);
});
