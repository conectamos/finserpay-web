import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import * as access from "../lib/solicitud-operation-access.ts";
import { getSolicitudActions } from "../lib/solicitudes.ts";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function declaration(file, name) {
  const source = read(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}
function load(source, globals) {
  const testModule = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module: testModule, exports: testModule.exports, Request, Response, URL, Buffer,
    console: { error() {}, warn() {} }, ...globals });
  return testModule.exports;
}
const user = {
  id: 7, rolNombre: "ADMIN", activo: true, aliadoAccesoCodigo: "ALIADO",
  sedeId: 31, sedeAccesoId: 31, aliadoId: 12, aliadoAccesoId: 12,
  sedeAccesoActiva: true, aliadoAccesoActivo: true,
};
const ownDraft = { id: 90, usuarioId: user.id, vendedorId: null,
  aliadoId: user.aliadoId, sedeId: user.sedeId, currentStep: 2,
  clienteDocumento: "001234567", dataCreditoAssessmentId: "approved-original" };
const json = (body, init) => Response.json(body, init);

test("el nuevo actor exige administrador aliado activo y contexto de acceso coherente", () => {
  assert.equal(access.canActAsAllySalesAdmin(user), true);
  for (const override of [
    { rolNombre: "VENDEDOR" }, { rolNombre: "ANALISTA_APROBACION" },
    { aliadoAccesoCodigo: "FINSERPAY" }, { id: 0 }, { activo: false },
    { activo: undefined }, { sedeAccesoActiva: false }, { sedeAccesoActiva: undefined },
    { aliadoAccesoActivo: false }, { aliadoAccesoActivo: undefined },
    { aliadoId: 13 }, { aliadoAccesoId: null }, { sedeId: 32 }, { sedeAccesoId: null },
  ]) assert.equal(access.canActAsAllySalesAdmin({ ...user, ...override }), false, JSON.stringify(override));
  assert.equal(access.canActAsAllySalesAdmin(null), false);
});

test("el administrador origina como usuario y opera únicamente solicitudes propias sin vendedor", () => {
  const actor = { central: false, admin: access.canActAsAllySalesAdmin(user),
    userId: user.id, viewerAllyId: user.aliadoId, seller: null };
  assert.equal(access.canOriginateSolicitud(actor), true);
  assert.equal(access.canOperateSolicitud({ ...actor, owner: ownDraft }), true);
  for (const owner of [null, { ...ownDraft, usuarioId: 8 },
    { ...ownDraft, aliadoId: 13 }, { ...ownDraft, vendedorId: 7 },
    { ...ownDraft, vendedorId: undefined }, { ...ownDraft, usuarioId: null },
  ]) assert.equal(access.canOperateSolicitud({ ...actor, owner }), false);
  for (const override of [{ admin: false }, { userId: 0 }, { viewerAllyId: null }])
    assert.equal(access.canOriginateSolicitud({ ...actor, ...override }), false);
  assert.equal(access.canOperateSolicitud({ ...actor, central: true, owner: { ...ownDraft, usuarioId: 999, aliadoId: 999 } }), true);
  const seller = { id: 41, tipoPerfil: "VENDEDOR" };
  assert.equal(access.canOperateSolicitud({ ...actor, admin: false, seller, owner: { ...ownDraft, vendedorId: 41 } }), true);
  assert.equal(access.canOperateSolicitud({ ...actor, admin: false, seller, owner: { ...ownDraft, vendedorId: 42 } }), false);
});

function draftFixture({ actor = user, owner = ownDraft } = {}) {
  const saves = [];
  const source = declaration("app/api/creditos/borradores/route.ts", "POST");
  const routes = load(source, {
    ...access, NextResponse: { json },
    getAccess: async () => actor ? { user: actor, admin: actor.rolNombre === "ADMIN", central: false, seller: null } : null,
    expireStaleSolicitudes: async () => {}, ensureVeriffSchema: async () => {}, ensureFirmaSeguroSchema: async () => {},
    normalizePayload: value => structuredClone(value || {}),
    sanitizeText: value => String(value || "").trim(),
    clampStep: value => Math.max(1, Math.min(5, Number(value) || 1)),
    parsePositiveId: value => Number(value) || null,
    extractDraftFields: payload => payload,
    getActiveSolicitudCreditContext: async () => owner,
    assertDocumentNotBlacklisted: async () => {},
    prisma: { $queryRawUnsafe: async () => [{ signed: true }] },
    requiresCreditClientStepValidation: () => false,
    saveSolicitudDraft: async input => { saves.push(input); return { id: 90 }; },
    readDrafts: async () => [{ id: 90, payload: saves.at(-1)?.payload }], serializeDraft: row => row,
    documentBlacklistErrorResponse: () => null,
    ImeiConfirmationError: class extends Error {}, CreditClientStepValidationError: class extends Error {},
    ActiveSolicitudConflictError: class extends Error {}, SolicitudCanonicalMutationError: class extends Error {},
    DRAFT_REQUIRES_DATACREDITO_CODE: "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO",
  });
  return { saves, async send(body = {}) {
    return routes.POST(new Request("https://test.invalid/api/creditos/borradores", {
      method: "POST", body: JSON.stringify({ id: 90, currentStep: 2,
        payload: { clienteDocumento: ownDraft.clienteDocumento, usuarioId: 999, vendedorId: 999, sedeId: 999 }, ...body }),
    }));
  } };
}

test("guardar el borrador conserva titular, sede y consulta originales sin aceptar propietarios del navegador", async () => {
  const f = draftFixture();
  assert.equal((await f.send()).status, 200);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].usuarioId, user.id);
  assert.equal(f.saves[0].vendedorId, null);
  assert.equal(f.saves[0].sedeId, user.sedeId);
  assert.equal(f.saves[0].payload.dataCreditoAssessmentId, ownDraft.dataCreditoAssessmentId);
});

test("guardar rechaza acceso ajeno, inactivo o sin contexto antes de escribir", async () => {
  for (const owner of [null, { ...ownDraft, usuarioId: 8 }, { ...ownDraft, aliadoId: 99 }, { ...ownDraft, vendedorId: 7 }]) {
    const f = draftFixture({ owner }); assert.equal((await f.send()).status, 403);
    assert.equal(f.saves.length, 0);
  }
  for (const override of [{ activo: false }, { sedeAccesoActiva: false }, { aliadoAccesoActivo: false }, { aliadoAccesoId: 99 }]) {
    const f = draftFixture({ actor: { ...user, ...override } });
    assert.equal((await f.send()).status, 403); assert.equal(f.saves.length, 0);
  }
  assert.equal((await draftFixture({ actor: null }).send()).status, 401);
});

function closingFixture({ actor = user, owner = ownDraft } = {}) {
  const code = declaration("app/api/creditos/route.ts", "POST");
  let blacklists = 0;
  const reached = new Error("STOP_BEFORE_ANY_FINANCIAL_OR_PROVIDER_OPERATION");
  const routes = load(code, {
    ...access, canOperateSolicitudContext: access.canOperateSolicitud,
    NextResponse: { json }, getSessionUser: async () => actor,
    isAdminRole: role => role === "ADMIN", isFinserPayCentralAlly: code => code === "FINSERPAY",
    getSellerSessionUser: async () => null,
    sanitizeText: value => String(value || "").trim(), toNullableDate: () => null,
    parseId: value => Number(value) || null,
    getActiveSolicitudCreditContext: async () => owner,
    getFinalizedSolicitudCreditContext: async () => null,
    documentValuesMatch: (a, b) => a === b,
    assertDocumentNotBlacklisted: async () => { blacklists += 1; throw reached; },
    documentBlacklistErrorResponse: error => error === reached ? json({ code: "TEST_AUTHORIZED_BOUNDARY" }, { status: 418 }) : null,
    FirmaSeguroFullNameIdentityError: class extends Error {}, ImeiConfirmationError: class extends Error {},
    SecondCreditAuthorizationError: class extends Error {}, VeriffValidationFinalizationError: class extends Error {},
    VeriffValidationSupersededError: class extends Error {}, FirmaSeguroFinalizationError: class extends Error {},
    ActiveSolicitudConflictError: class extends Error {}, CreditDeviceReplacementError: class extends Error {},
  });
  return { get blacklists() { return blacklists; }, send(body = {}) {
    return routes.POST(new Request("https://test.invalid/api/creditos", { method: "POST",
      body: JSON.stringify({ solicitudId: "90", clienteDocumento: ownDraft.clienteDocumento, ...body }) }));
  } };
}

test("el cierre exige solicitud propia y cédula coincidente antes de todas las integraciones", async () => {
  const f = closingFixture();
  const response = await f.send();
  assert.equal(response.status, 418); assert.equal((await response.json()).code, "TEST_AUTHORIZED_BOUNDARY");
  assert.equal(f.blacklists, 1);
  for (const owner of [null, { ...ownDraft, usuarioId: 8 }, { ...ownDraft, aliadoId: 99 }, { ...ownDraft, vendedorId: 7 }]) {
    const denied = closingFixture({ owner });
    assert.equal((await denied.send()).status, owner ? 403 : 409); assert.equal(denied.blacklists, 0);
  }
  const missing = closingFixture();
  const responseMissing = await missing.send({ solicitudId: undefined });
  assert.equal(responseMissing.status, 409); assert.equal((await responseMissing.json()).code, "SOLICITUD_REQUERIDA");
  const mismatch = closingFixture(); assert.equal((await mismatch.send({ clienteDocumento: "999" })).status, 409);
  assert.equal(mismatch.blacklists, 0);
});

test("el cierre no confiere permiso a un administrador inactivo ni eleva los datos sensibles", async () => {
  for (const override of [{ activo: false }, { sedeAccesoActiva: false }, { aliadoAccesoActivo: false }, { aliadoAccesoId: 99 }]) {
    const f = closingFixture({ actor: { ...user, ...override } });
    assert.equal((await f.send()).status, 403); assert.equal(f.blacklists, 0);
  }
  const source = read("app/api/creditos/route.ts");
  assert.match(source, /canViewSensitiveCredit = adminCentral/);
  assert.equal((source.match(/admin: allySalesAdmin, userId: user\.id/g) || []).length, 5,
    "initial authorization and every recovery/locked check bind the same actor");
});

test("el muro ofrece continuar y desistir solo al administrador creador de la solicitud", () => {
  const viewer = { kind: "ALLY_ADMIN", userId: user.id, aliadoId: user.aliadoId, sedeId: user.sedeId, vendedorId: null };
  const draft = { viewer, ownership: ownDraft, source: "DRAFT", draftState: "ABIERTO", state: "EN_PROCESO" };
  assert.deepEqual(getSolicitudActions(draft), ["VER_DETALLE", "ABRIR_FABRICA", "DESISTIR"]);
  for (const ownership of [{ ...ownDraft, usuarioId: 8 }, { ...ownDraft, vendedorId: 7 }])
    assert.deepEqual(getSolicitudActions({ ...draft, ownership }), ["VER_DETALLE"]);
  assert.deepEqual(getSolicitudActions({ ...draft, ownership: { ...ownDraft, aliadoId: 99 } }), []);
  assert.deepEqual(getSolicitudActions({ ...draft, source: "CREDIT", state: "APROBADA" }), ["VER_DETALLE"]);
});

test("desistimiento ejecuta SQL real: titular usuario, vendedor nulo, aliado y auditoría sin borrar", async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER NOT NULL);
    INSERT INTO "Sede" VALUES (31,12),(32,12),(33,13);
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "estado" TEXT DEFAULT 'ABIERTO', "creditoId" INTEGER,
      "usuarioId" INTEGER,"vendedorId" INTEGER,"sedeId" INTEGER,"clienteDocumento" TEXT,
      "dataCreditoAssessmentId" UUID,"payload" JSONB DEFAULT '{"solicitudOrigen":"DATACREDITO"}',
      "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      "closedAt" TIMESTAMPTZ,"closedReason" TEXT,"desistedByUserId" INTEGER,"desistedBySellerId" INTEGER);
    CREATE TABLE "Credito" ("id" INTEGER,"estado" TEXT,"clienteDocumento" TEXT,"createdAt" TIMESTAMPTZ);
    INSERT INTO "CreditoBorrador" ("id","usuarioId","vendedorId","sedeId","clienteDocumento") VALUES
      (90,7,NULL,31,'001234567'),(91,7,NULL,32,'001234567'),
      (92,8,NULL,31,'001234567'),(93,7,7,31,'001234567'),(94,7,NULL,33,'001234567');
  `);
  const locks = [];
  const adapter = db => ({ $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows });
  const functions = load([
    declaration("lib/solicitudes-storage.ts", "findBlockingSolicitudByDocument"),
    declaration("lib/solicitudes-storage.ts", "desistSolicitud"),
  ].join("\n"), {
    prisma: { $transaction: callback => pg.transaction(db => callback(adapter(db))) },
    ensureSolicitudSchema: async () => {}, expireStaleSolicitudes: async () => {},
    normalizeDigits: value => String(value || "").replace(/\D/g, ""),
    lockSolicitudOperationsInOrder: async (_db, ids) => locks.push(Array.from(ids)),
    lockIdentity: async () => {},
  });
  const run = solicitudId => functions.desistSolicitud({ solicitudId, userId: 7, sellerId: null, aliadoId: 12 });
  for (const id of [92, 93, 94]) assert.equal((await run(id)).changed, false, String(id));
  const result = await run(90); assert.equal(result.changed, true); assert.equal(result.identityReleased, false);
  const rows = (await pg.query('SELECT * FROM "CreditoBorrador" ORDER BY "id"')).rows;
  assert.equal(rows.length, 5, "all records remain stored");
  for (const row of rows) {
    assert.equal(row.estado, [90,91].includes(row.id) ? "CERRADO" : "ABIERTO", String(row.id));
    if ([90,91].includes(row.id)) {
      assert.equal(row.closedReason, "DESISTIDA"); assert.equal(row.desistedByUserId, 7);
      assert.equal(row.desistedBySellerId, null); assert.ok(row.closedAt);
    }
  }
  assert.deepEqual(locks, [[90,91]]);
  assert.equal((await run(90)).changed, false, "retry does not change prior audit");
});
