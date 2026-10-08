import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

function load(file, dependencies = {}) {
  const loadedModule = { exports: {} };
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: loadedModule, exports: loadedModule.exports, Date, Object, Number, Set, String, Request, Response,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    } }, { filename: file });
  return loadedModule.exports;
}
const core = load("lib/approval-request-correction-core.ts", {
  "./credit-client-name": load("lib/credit-client-name.ts"),
  "./credit-contact-phones": load("lib/credit-contact-phones.ts"),
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const allFields = [...core.REQUEST_CORRECTION_FIELDS];
const payload = {
  clientePrimerNombre: "MARIA", clientePrimerApellido: "PRUEBA", clienteSegundoApellido: "DEMO",
  clienteNombre: "MARIA PRUEBA DEMO", clienteTelefono: "3001234567", clienteCorreo: "maria@example.com",
  clienteDireccion: "Calle de pruebas 1", clienteDepartamento: "Cundinamarca", clienteCiudad: "Bogotá",
  clienteFechaNacimiento: "1990-03-02", clienteFechaExpedicion: "2010-02-01",
  clienteDocumento: "123456789", referenciaFamiliar1Telefono: "3011234567",
  referenciaFamiliar2Telefono: "3021234567", valorEquipoTotal: "4500000", plazoMeses: "40",
  imei: "350000000000001", wizardStep: 2,
};
function input(changes, baseline = payload, revision = core.requestDataRevision(baseline)) {
  return core.parseRequestDataCorrection({ values: changes,
    expectedValues: Object.fromEntries(Object.keys(changes).map((field) => [field, String(baseline[field] ?? "")])),
    expectedRevision: revision, reason: "Corrección cotejada con el cliente" });
}
function corrected(changes, baseline = payload) {
  return core.applyRequestDataCorrection(baseline, input(changes, baseline), allFields, "Analista de pruebas",
    new Date("2026-10-08T17:00:00Z"));
}

test("corrige contacto/nombres sin tocar cédula, primer apellido, equipo ni finanzas", () => {
  const result = corrected({ clientePrimerNombre: "Ana Maria", clienteTelefono: "+57 310 123 4567" });
  assert.equal(result.payload.clienteNombre, "ANA MARIA PRUEBA DEMO");
  assert.equal(result.payload.clienteTelefono, "3101234567");
  for (const field of ["clienteDocumento", "clientePrimerApellido", "imei", "valorEquipoTotal", "plazoMeses", "wizardStep"])
    assert.equal(result.payload[field], payload[field]);
  assert.equal(result.payload.analystDataRevision, 1);
  assert.equal(result.payload.analystDataCorrection.actorName, "Analista de pruebas");
  assert.equal(result.payload.analystDataCorrection.updatedAt, "2026-10-08T17:00:00.000Z");
  assert.deepEqual(clone(result.before), { clientePrimerNombre: "MARIA", clienteTelefono: "3001234567", clienteNombre: "MARIA PRUEBA DEMO" });
});

test("un autosave anterior conserva la corrección y guarda finanzas/equipo locales independientes", () => {
  const server = corrected({ clienteTelefono: "3101234567", clienteCorreo: "ana@example.com" }).payload;
  const saved = core.preserveAnalystDataCorrectionAutosave(server, { ...payload,
    analystDataRevision: 0, valorEquipoTotal: "5000000", plazoMeses: "36" });
  assert.equal(saved.clienteTelefono, "3101234567");
  assert.equal(saved.clienteCorreo, "ana@example.com");
  assert.equal(saved.valorEquipoTotal, "5000000");
  assert.equal(saved.plazoMeses, "36");
  assert.equal(saved.analystDataRevision, 1);
});

test("un asesor que ya recibió la revisión puede guardar un nuevo cambio legítimo", () => {
  const server = corrected({ clienteTelefono: "3101234567" }).payload;
  const saved = core.preserveAnalystDataCorrectionAutosave(server, { ...server, clienteTelefono: "3111234567" });
  assert.equal(saved.clienteTelefono, "3111234567");
  assert.equal(saved.analystDataCorrection.values.clienteTelefono, "3111234567");
  assert.equal(saved.analystDataCorrection.actorName, "Analista de pruebas");
});

test("el navegador no puede fabricar, eliminar o retroceder el registro de corrección", () => {
  const forged = { ...payload, analystDataRevision: 999, analystDataCorrection: { actorName: "Falso", fields: ["imei"] } };
  const initial = core.preserveAnalystDataCorrectionAutosave(payload, forged);
  assert.equal(initial.analystDataRevision, undefined);
  assert.equal(initial.analystDataCorrection, undefined);
  const server = corrected({ clienteTelefono: "3101234567" }).payload;
  for (const revision of [undefined, -1, 0, 999, "1"]) {
    const saved = core.preserveAnalystDataCorrectionAutosave(server, { ...forged, analystDataRevision: revision });
    assert.equal(saved.clienteTelefono, "3101234567");
    assert.equal(saved.analystDataRevision, 1);
    assert.equal(saved.analystDataCorrection.actorName, "Analista de pruebas");
    assert.deepEqual(clone(saved.analystDataCorrection.fields), ["clienteTelefono"]);
  }
});

test("el conflicto compara solo los datos editados y rechaza una segunda revisión obsoleta", () => {
  const editPhone = input({ clienteTelefono: "3101234567" });
  assert.doesNotThrow(() => core.applyRequestDataCorrection({ ...payload, clienteDireccion: "Otra calle 22" }, editPhone, allFields, "Analista"));
  assert.throws(() => core.applyRequestDataCorrection({ ...payload, clienteTelefono: "3111234567" }, editPhone, allFields, "Analista"), { code: "REQUEST_CHANGED" });
  assert.throws(() => core.applyRequestDataCorrection(corrected({ clienteCorreo: "ana@example.com" }).payload, editPhone, allFields, "Analista"), { code: "REQUEST_CHANGED" });
});

test("fieldRevisions identifica volver al valor histórico y conserva campos acumulados", () => {
  const revision1 = corrected({ clienteTelefono: "3101234567" }).payload;
  const advisor = core.preserveAnalystDataCorrectionAutosave(revision1, { ...revision1, clienteTelefono: "3111234567" });
  const revision2 = corrected({ clienteTelefono: "3101234567", clienteCorreo: "ana@example.com" }, advisor).payload;
  assert.equal(revision2.analystDataCorrection.fieldRevisions.clienteTelefono, 2);
  assert.equal(revision2.analystDataCorrection.fieldRevisions.clienteCorreo, 2);
  assert.deepEqual(clone(revision2.analystDataCorrection.fields), ["clienteTelefono", "clienteCorreo"]);
});

test("datos sin modificar, aunque incompletos, no impiden corregir otro campo", () => {
  const current = { ...payload, clienteCorreo: "", clienteDireccion: "" };
  assert.doesNotThrow(() => corrected({ clienteCorreo: "", clienteDireccion: "", clienteTelefono: "3101234567" }, current));
});

test("valida celular, correo, fecha y referencias sin aceptar campos financieros o identidad canónica", () => {
  for (const changes of [{ clienteTelefono: "3011234567" }, { clienteTelefono: "120" },
    { clienteCorreo: "sin correo" }, { clienteFechaNacimiento: "2026-02-30" },
    { clienteFechaNacimiento: "2027-01-01" }, { clientePrimerNombre: "123" }])
    assert.throws(() => corrected(changes));
  for (const field of ["clienteDocumento", "clientePrimerApellido", "clienteTipoDocumento", "imei", "valorEquipoTotal", "analystDataRevision"])
    assert.throws(() => input({ [field]: "otro" }), { code: "INVALID_FIELDS" });
  assert.throws(() => core.parseRequestDataCorrection({ values: { clienteCorreo: "ana@example.com" }, expectedValues: {}, expectedRevision: 0, reason: "Valido" }), { code: "INVALID_FIELDS" });
});

test("identidad iniciada bloquea nombres; firma, cierre y vencimiento bloquean corrección cruda", () => {
  const base = { open: true, expired: false, signatureStarted: false, identityStarted: false, correctionPending: false };
  const identity = core.requestDataEligibility({ ...base, identityStarted: true });
  assert.equal(identity.editableFields.includes("clientePrimerNombre"), false);
  assert.equal(identity.editableFields.includes("clienteTelefono"), true);
  assert.throws(() => core.applyRequestDataCorrection(payload, input({ clientePrimerNombre: "ANA" }), identity.editableFields, "Analista"), { code: "FIELD_LOCKED" });
  for (const state of [{ open: false }, { expired: true }, { signatureStarted: true }, { correctionPending: true }])
    assert.equal(core.requestDataEligibility({ ...base, ...state }).editableFields.length, 0);
  assert.equal(core.requestDataEligibility({ ...base, expired: true, signatureStarted: true }).canManageContract, false);
  assert.equal(core.requestDataEligibility({ ...base, signatureStarted: true }).canManageContract, true);
});

test("cambiar identidad invalida evidencias y un autosave viejo no restaura las fotos", () => {
  const previous = { ...payload, contratoCedulaFrenteDataUrl: "data:image/jpeg;base64,anterior", fotoEntregaDataUrl: "entrega" };
  const server = corrected({ clientePrimerNombre: "ANA" }, previous).payload;
  assert.equal(server.contratoCedulaFrenteDataUrl, undefined);
  assert.equal(server.fotoEntregaDataUrl, "entrega");
  const stale = core.preserveAnalystDataCorrectionAutosave(server, previous);
  assert.equal(stale.contratoCedulaFrenteDataUrl, undefined);
  const fresh = core.preserveAnalystDataCorrectionAutosave(server, { ...server, contratoCedulaFrenteDataUrl: "foto-nueva" });
  assert.equal(fresh.contratoCedulaFrenteDataUrl, "foto-nueva");
});

function routeFixture({ analyst = { id: 17, nombre: "Analista" }, shared = undefined } = {}) {
  const calls = [];
  const route = load("app/api/aprobaciones/solicitudes/[id]/datos/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getNominalApprovalAnalystSessionUser: async () => analyst },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/credit-approval-http": { readApprovalRequest: async (request) => { calls.push("body"); return request.json(); },
      approvalErrorResponse: () => Response.json({ ok: false }, { status: 503 }) },
    "@/lib/approval-request-correction-core": core,
    "@/lib/approval-request-correction": { parseCorrectionDraftId: (id) => {
      if (id !== "D-7") throw new core.RequestDataCorrectionError("REQUEST_NOT_FOUND", "No disponible", 404);
      return 7;
    }, getAnalystRequestCorrection: async (id) => { calls.push(["get", id]); return { revision: 0 }; },
    correctAnalystRequestData: async (id, data, actor) => { calls.push(["patch", id, data, actor]); return { revision: 1 }; } },
  });
  return { route, calls };
}
const context = { params: Promise.resolve({ id: "D-7" }) };
test("GET/PATCH requieren analista nominal y excluyen enlaces compartidos antes de leer o mutar", async () => {
  for (const auth of [{ analyst: null }, { shared: null }, { shared: { kind: "SHARED_LINK" } }]) {
    const f = routeFixture(auth);
    assert.equal((await f.route.GET(new Request("https://finser.test/api/aprobaciones/solicitudes/D-7/datos"), context)).status, 401);
    assert.equal((await f.route.PATCH(new Request("https://finser.test/api/aprobaciones/solicitudes/D-7/datos", { method: "PATCH", body: "{}" }), context)).status, 401);
    assert.equal(f.calls.length, 0);
  }
});
test("el endpoint conserva identidad del actor y entrega revisión privada sin aceptar ids de crédito", async () => {
  const f = routeFixture();
  const result = await f.route.PATCH(new Request("https://finser.test/api/aprobaciones/solicitudes/D-7/datos", {
    method: "PATCH", body: JSON.stringify({ values: { clienteTelefono: "3101234567" }, expectedValues: { clienteTelefono: "3001234567" }, expectedRevision: 0, reason: "Corrección del celular" }),
  }), context);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control"), /private, no-store/);
  assert.equal(f.calls[1][3].id, 17);
  assert.equal((await result.json()).item.revision, 1);
  assert.equal((await f.route.GET(new Request("https://finser.test/"), { params: Promise.resolve({ id: "C-7" }) })).status, 404);
});

async function serviceFixture() {
  const db = new PGlite();
  const calls = [];
  await db.exec(`CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY,"estado" TEXT NOT NULL,
    "creditoId" INTEGER,"clienteNombre" TEXT,"clienteTelefono" TEXT,"payload" JSONB,
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),"expiresAt" TIMESTAMPTZ DEFAULT NOW()+INTERVAL '15 days',"updatedAt" TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE "FirmaSeguroProcess" ("draftId" INTEGER);
    CREATE TABLE "VeriffIdentityValidation" ("draftId" INTEGER);
    CREATE TABLE "ApprovalOperationalAction" ("id" UUID PRIMARY KEY,"targetKind" TEXT,"targetId" INTEGER,
      "eventType" TEXT,"actorUserId" INTEGER,"actorName" TEXT CHECK("actorName"<>'Fail'),"reason" TEXT,
      "beforeContact" JSONB,"afterContact" JSONB,"status" TEXT);`);
  await db.query(`INSERT INTO "CreditoBorrador"("id","estado","clienteNombre","clienteTelefono","payload") VALUES(7,'ABIERTO',$1,$2,$3::jsonb)`,
    [payload.clienteNombre, payload.clienteTelefono, JSON.stringify(payload)]);
  const connection = {
    async $queryRawUnsafe(sql, ...args) { calls.push("query"); return (await db.query(sql, args)).rows; },
    async $executeRawUnsafe(sql, ...args) { calls.push(sql.startsWith("INSERT") ? "audit" : "mutation"); return (await db.query(sql, args)).affectedRows; },
  };
  const prisma = { async $transaction(fn) {
    await db.exec("BEGIN");
    try { const value = await fn(connection); await db.exec("COMMIT"); return value; }
    catch (error) { await db.exec("ROLLBACK"); throw error; }
  } };
  const service = load("lib/approval-request-correction.ts", {
    "server-only": {}, "node:crypto": { randomUUID }, "@/lib/prisma": { default: prisma },
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {},
      lockSolicitudOperationMutation: async () => { calls.push("operation-lock"); } },
    "@/lib/solicitudes-storage": { ensureSolicitudSchema: async () => {} },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {},
      lockVeriffDraftAttempts: async () => { calls.push("identity-lock"); } },
    "@/lib/approval-request-correction-core": core,
  });
  return { db, calls, service };
}

test("servicio guarda filas, payload y auditoría en una transacción después de ambos locks", async () => {
  const f = await serviceFixture();
  try {
    const result = await f.service.correctAnalystRequestData(7, input({ clienteTelefono: "3101234567" }), { id: 17, nombre: "Analista" });
    assert.equal(result.revision, 1);
    assert.deepEqual(f.calls.slice(0, 2), ["operation-lock", "identity-lock"]);
    const { rows: [saved] } = await f.db.query(`SELECT "clienteTelefono","payload" FROM "CreditoBorrador" WHERE "id"=7`);
    assert.equal(saved.clienteTelefono, "3101234567");
    assert.equal(saved.payload.clienteTelefono, "3101234567");
    assert.equal(saved.payload.plazoMeses, "40");
    const { rows: [audit] } = await f.db.query(`SELECT * FROM "ApprovalOperationalAction"`);
    assert.equal(audit.actorUserId, 17);
    assert.equal(audit.reason, "Corrección cotejada con el cliente");
    assert.equal(audit.beforeContact.clienteTelefono, "3001234567");
    assert.equal(audit.afterContact.clienteTelefono, "3101234567");
    assert.equal(audit.status, "DATA_CORRECTED");
    await assert.rejects(f.service.correctAnalystRequestData(7, input({ clienteCorreo: "ana@example.com" }), { id: 18, nombre: "Otro analista" }), { code: "REQUEST_CHANGED" });
    assert.equal((await f.db.query(`SELECT COUNT(*)::integer AS count FROM "ApprovalOperationalAction"`)).rows[0].count, 1);
  } finally { await f.db.close(); }
});

test("una firma o identidad iniciada entre GET y PATCH vuelve a comprobarse bajo lock", async () => {
  const f = await serviceFixture();
  try {
    const observed = await f.service.getAnalystRequestCorrection(7);
    assert.ok(observed.editableFields.includes("clientePrimerNombre"));
    await f.db.query(`INSERT INTO "VeriffIdentityValidation"("draftId") VALUES(7)`);
    await assert.rejects(f.service.correctAnalystRequestData(7, input({ clientePrimerNombre: "ANA" }), { id: 17, nombre: "Analista" }), { code: "FIELD_LOCKED" });
    await f.db.query(`INSERT INTO "FirmaSeguroProcess"("draftId") VALUES(7)`);
    await assert.rejects(f.service.correctAnalystRequestData(7, input({ clienteTelefono: "3101234567" }), { id: 17, nombre: "Analista" }), { code: "REQUEST_LOCKED" });
    assert.equal((await f.db.query(`SELECT COUNT(*)::integer AS count FROM "ApprovalOperationalAction"`)).rows[0].count, 0);
    assert.equal((await f.db.query(`SELECT "clienteTelefono" FROM "CreditoBorrador"`)).rows[0].clienteTelefono, "3001234567");
  } finally { await f.db.close(); }
});

test("si no puede escribirse la auditoría, también se revierte la corrección de datos", async () => {
  const f = await serviceFixture();
  try {
    await assert.rejects(f.service.correctAnalystRequestData(7, input({ clienteTelefono: "3101234567" }), { id: 17, nombre: "Fail" }));
    const { rows: [saved] } = await f.db.query(`SELECT "clienteTelefono","payload" FROM "CreditoBorrador" WHERE "id"=7`);
    assert.equal(saved.clienteTelefono, "3001234567");
    assert.equal(saved.payload.analystDataRevision, undefined);
    assert.equal((await f.db.query(`SELECT COUNT(*)::integer AS count FROM "ApprovalOperationalAction"`)).rows[0].count, 0);
  } finally { await f.db.close(); }
});

test("Veriff usa nombres y tipo autoritativos después del lock aunque el asesor envíe un nombre viejo", async () => {
  const calls = [];
  const authoritative = { ...corrected({ clientePrimerNombre: "ANA MARIA" }).payload,
    clienteTipoDocumento: "CC", equipoMarca: "MARCA", equipoModelo: "MODELO", cuotaInicial: "1000000",
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-11-01" };
  let locked = false;
  const route = load("app/api/creditos/veriff/route.ts", {
    "node:crypto": { randomUUID }, "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async () => {} },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/auth": { getSessionUser: async () => ({ id: 11 }) },
    "@/lib/credit-factory": { PAYMENT_FREQUENCY_OPTIONS: [{ value: "QUINCENAL" }],
      sanitizeText: (value) => String(value ?? "").trim(), toNumber: (value) => Number(value || 0) },
    "@/lib/prisma": { default: { $queryRawUnsafe: async () => [{ id: 7, estado: "ABIERTO", usuarioId: 11,
      vendedorId: 19, sedeId: 1, aliadoId: 1, currentStep: 4, plataforma: "IPHONE",
      clienteDocumento: payload.clienteDocumento, payload: locked ? authoritative : payload }] } },
    "@/lib/veriff-storage": { createVeriffValidation: async (reservation) => {
      calls.push(["reservation", reservation]); return { created: true, row: { id: 88 } };
    }, getVeriffValidationById: async () => null, getReusableVeriffValidationForDraft: async () => null,
    serializeVeriffValidation: (value) => value, updateVeriffValidation: async (id, data) => ({ id, ...data }) },
    "@/lib/seller-auth": { getSellerSessionUser: async () => ({ id: 19 }) },
    "@/lib/veriff-access": { canOperateVeriffDraft: () => true },
    "@/lib/solicitudes-storage": { expireStaleSolicitudes: async () => {} },
    "@/lib/firmaseguro-storage": { tryAcquireSolicitudOperationLock: async () => {
      locked = true; calls.push(["lock"]); return { release: async () => { calls.push(["release"]); } };
    } },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: false }) },
    "@/lib/datacredito/storage": { getApprovedDataCreditoAssessmentForCredit: async () => null },
    "@/lib/veriff": { VeriffApiError: class extends Error {}, isVeriffConfigured: () => true,
      getVeriffPublicSummary: () => ({}), redactVeriffPayload: (value) => value,
      extractVeriffSessionId: () => "test-session", extractVeriffSessionUrl: () => "https://veriff.test/session",
      veriffCreateSession: async (provider) => { calls.push(["provider", provider]); return {}; } },
    "@/lib/veriff-callback": { buildVeriffCompletionUrl: () => "https://finser.test/complete" },
    "@/lib/veriff-retry-policy": { getVeriffRetryPolicy: async () => ({ applicationRejected: false }) },
    "@/lib/veriff-session-recovery": { isRecoverableVeriffSessionReservation: () => false },
  });
  const response = await route.POST(new Request("https://finser.test/api/creditos/veriff", {
    method: "POST", body: JSON.stringify({ draftId: 7, clienteDocumento: payload.clienteDocumento,
      clientePrimerNombre: "MARIA", clientePrimerApellido: "APELLIDO VIEJO", clienteTipoDocumento: "PASAPORTE" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(calls[0][0], "lock");
  const reserved = calls.find(([type]) => type === "reservation")[1];
  assert.equal(reserved.clienteNombre, "ANA MARIA PRUEBA");
  const sent = calls.find(([type]) => type === "provider")[1];
  assert.equal(sent.firstName, "ANA MARIA");
  assert.equal(sent.lastName, "PRUEBA");
  assert.equal(sent.documentType, "CC");
  assert.equal(calls.at(-1)[0], "release");
});
