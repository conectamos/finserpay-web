import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const identity = await jiti.import("../lib/datacredito/identity.ts");
const policy = await jiti.import("../lib/datacredito/policy.ts");
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const scope = { userId: 23, sellerId: 45, sedeId: 1, aliadoId: 9 };
const assessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const exceptionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const documentNumber = "1234567890";
const draftId = 31;
const offer = { initialPaymentPercentage: 20, suretyPercentage: 75,
  maxFinancedAmount: 3500000, installmentCount: 24, maxInstallmentAmount: 160000,
  policyVersion: 9, financialSettings: null };

function load(source, globals, risk) {
  const module = { exports: {} };
  const code = ts.transpileModule(source.replace(/^import\b[^;]*;\r?\n/gm, ""), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, Error, Date, console,
    process: { env: { NODE_ENV: "test" } }, ...globals,
    require: name => {
      assert.match(name, /(?:^|\/)risk-exception$/);
      return risk;
    },
  });
  return module.exports;
}
function declarations(file, names) {
  const source = read(file);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(item => item.name?.getText(tree) === name);
    assert.ok(node, name);
    return node.getText(tree);
  }).join("\n");
}
function matchingNodes(file, predicate) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) { if (predicate(node, tree)) matches.push(node); ts.forEachChild(node, visit); }
  visit(tree); return { tree, matches };
}

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "DataCreditoAssessment" ("id" UUID PRIMARY KEY,
    "status" TEXT, "consumedAt" TIMESTAMPTZ);
    INSERT INTO "DataCreditoAssessment" VALUES ('${assessmentId}','NO_EVALUADO',NULL);`);
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...args) => (await connection.query(sql, args)).rows,
    $executeRawUnsafe: async (sql, ...args) => (await connection.query(sql, args)).affectedRows,
  });
  const prisma = { ...adapter(db), $transaction: callback => db.transaction(tx => callback(adapter(tx))) };
  const row = { id: assessmentId, ...scope, status: "NO_EVALUADO", score: null,
    offer: null, policyVersion: 1, policyRevisionId: "raw-revision", platform: "IPHONE", providerEnvironment: "production" };
  let active = true;
  let approvedReads = 0;
  const checks = [];
  const risk = {
    getActiveCreditRiskExceptionForDraft: async input => {
      checks.push(input);
      return active && input.solicitudId === draftId && input.assessmentId === assessmentId &&
        input.documentNumber === documentNumber && Object.entries(scope).every(([key, value]) => input[key] === value)
        ? { id: exceptionId, offer } : null;
    },
    getCreditRiskAuthorizationForDraft: async input => {
      const grant = await risk.getActiveCreditRiskExceptionForDraft(input);
      return grant ? { source: "INTERNAL_EXCEPTION", assessment: row, offer,
        policyVersion: 9, policyRevisionId: "exception-revision", exceptionId,
        expiresAt: new Date(Date.now() + 3600000) } : null;
    },
  };
  const customer = load(read("lib/datacredito/customer-identity.ts"), {
    ...identity, prisma,
    getDataCreditoAssessmentById: async id => id === assessmentId ? row : null,
    dataCreditoAssessmentMatchesScope: (assessment, input) => Object.entries(scope).every(([key, value]) => input[key] === value),
    readDataCreditoIdentitySource: async () => ({ documentNumber, firstSurname: "CONSULTADO",
      providerPayload: { content: { respuesta: { validacion: { datosBasicos: { conInformacion: false } } } } } }),
  }, risk);
  const payload = { dataCreditoAssessmentId: assessmentId, creditRiskExceptionId: exceptionId,
    clienteDocumento: documentNumber, clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
    clientePrimerNombre: "María del Mar", clientePrimerApellido: "De la Peña", clienteSegundoApellido: "Muñoz" };
  async function complete() {
    await customer.completeMissingDataCreditoIdentity(row, {
      firstSurname: payload.clientePrimerApellido, documentNumber, documentType: payload.clienteTipoDocumento,
      creditRiskExceptionId: exceptionId,
    }, { userId: 99, sellerId: null }, draftId);
    return customer.enforceDataCreditoCustomerIdentity(payload, scope, true, { userId: 99, sellerId: null }, draftId);
  }
  const globals = {
    ...policy, sanitizeText: value => String(value ?? "").trim(), toNumber: value => Number(value) || 0,
    getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, productionReady: true, environment: "production" }),
    isDataCreditoAuditConfigured: () => true, allowsDataCreditoNonProductionProvider: () => false,
    getApprovedDataCreditoAssessmentForCredit: async () => { approvedReads++; return null; },
    enforceDataCreditoCustomerIdentity: customer.enforceDataCreditoCustomerIdentity,
    enforceDataCreditoCustomerIdentityForVeriff: customer.enforceDataCreditoCustomerIdentityForVeriff,
    PAYMENT_FREQUENCY_OPTIONS: [{ value: "MENSUAL" }],
  };
  const firma = load(declarations("lib/firmaseguro-draft-credit-builder.ts", ["CreditValidationError", "getDraftDataCreditoOffer"]), globals, risk);
  const veriff = load(`${declarations("app/api/creditos/veriff/route.ts", ["validateDraftReadyForVeriff"])}\nexports.readiness = validateDraftReadyForVeriff;`, {
    ...globals, payloadObject: value => value,
  }, risk);
  const draft = { id: draftId, usuarioId: scope.userId, vendedorId: scope.sellerId, sedeId: scope.sedeId,
    aliadoId: scope.aliadoId, sedeAliadoId: scope.aliadoId, clienteDocumento: documentNumber, currentStep: 4,
    payload: { ...payload, imei: "123456789012345", equipoMarca: "Apple", equipoModelo: "iPhone 15",
      valorEquipoTotal: 2000000, cuotaInicial: 400000, plazoMeses: 12,
      frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-11-09" } };
  return { db, row, customer, payload, complete, firma, veriff, draft, checks,
    revoke: () => { active = false; }, approvedReads: () => approvedReads };
}

test("la excepción de riesgo no completa ni verifica una identidad ausente", async t => {
  const f = await fixture(t);
  await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity(f.payload, scope, false, undefined, draftId), /LOCKED_FIELDS|INCOMPLETE/);
  await assert.rejects(f.veriff.readiness(f.draft, "IPHONE"), /LOCKED_FIELDS|INCOMPLETE/);
  assert.equal(f.row.status, "NO_EVALUADO"); assert.equal(f.row.score, null); assert.equal(f.row.offer, null);
});

test("completar identidad autorizadamente conserva originales y actor sin habilitar edición del primer apellido", async t => {
  const f = await fixture(t); const completed = await f.complete();
  assert.equal(completed.original.names, ""); assert.equal(completed.original.firstSurname, "");
  assert.equal(completed.original.documentNumber, "");
  assert.equal(completed.effective.fullName, "María del Mar De la Peña Muñoz");
  assert.deepEqual(Array.from(completed.effective.manuallyCompleted), ["firstSurname", "documentType", "documentNumber"]);
  const audit = await f.db.query('SELECT "userId","original","effective" FROM "DataCreditoIdentityCorrection" ORDER BY "id"');
  assert.equal(audit.rows.length, 2); assert.ok(audit.rows.every(item => item.userId === 99));
  assert.ok(audit.rows.every(item => item.original.firstSurname === ""));
  await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...f.payload, clientePrimerApellido: "Otro" }, scope, true, undefined, draftId), /LOCKED_FIELDS/);
  await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...f.payload, clienteDocumento: "9876543210" }, scope, false, undefined, draftId), /UNAUTHORIZED|DOCUMENT_MISMATCH/);
  const restored = await f.customer.enforceDataCreditoCustomerIdentity({ ...f.payload }, scope, false, undefined, draftId);
  assert.equal(restored.effective.fullName, completed.effective.fullName);
  assert.equal(f.row.status, "NO_EVALUADO"); assert.equal(f.row.score, null);
});

test("Veriff y FirmaSeguro aceptan autoridad interna válida sin aceptar NO_EVALUADO por sí solo", async t => {
  const f = await fixture(t); await f.complete();
  const ready = await f.veriff.readiness(f.draft, "IPHONE"); assert.equal(ready.ok, true);
  const terms = await f.firma.getDraftDataCreditoOffer(f.draft, { ...f.payload }, "IPHONE");
  assert.equal(terms.authorizationSource, "INTERNAL_EXCEPTION"); assert.equal(terms.creditRiskExceptionId, exceptionId);
  assert.equal(terms.policyVersion, 9); assert.equal(terms.policyRevisionId, "exception-revision");
  assert.equal(terms.maxFinancedAmount, 3500000); assert.equal(f.approvedReads(), 0);
  assert.equal(f.row.status, "NO_EVALUADO"); assert.equal(f.row.policyVersion, 1); assert.equal(f.row.score, null);
  f.revoke();
  await assert.rejects(f.veriff.readiness(f.draft, "IPHONE"), /UNAUTHORIZED/);
  await assert.rejects(f.firma.getDraftDataCreditoOffer(f.draft, { ...f.payload }, "IPHONE"), /UNAUTHORIZED/);
});

test("otra solicitud, otro alcance y un ID de excepción forjado no reutilizan la autoridad", async t => {
  const f = await fixture(t); await f.complete();
  for (const [payload, inputScope, id] of [
    [f.payload, scope, draftId + 1],
    [f.payload, { ...scope, userId: scope.userId + 1 }, draftId],
    [{ ...f.payload, creditRiskExceptionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, scope, draftId],
    [{ ...f.payload, creditRiskExceptionId: "" }, scope, draftId],
  ]) await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...payload }, inputScope, false, undefined, id), /UNAUTHORIZED/);
  const signed = await f.customer.getScopedDataCreditoQueryIdentity(assessmentId, scope, documentNumber, draftId, exceptionId);
  assert.equal(signed.querySurname, "CONSULTADO"); assert.equal(signed.assessment.status, "NO_EVALUADO");
  await assert.rejects(f.customer.getScopedDataCreditoQueryIdentity(assessmentId, scope, documentNumber), /UNAUTHORIZED/);
});

test("una pestaña obsoleta no cambia los nombres enviados a Veriff en una excepción con identidad completada", async () => {
  const names = ["fullNameIdentity", "controlledIdentity", "correctedIdentity", "clientePrimerNombre", "clientePrimerApellido", "clienteNombre", "clienteApellidosVeriff"];
  const { tree, matches } = matchingNodes("app/api/creditos/veriff/route.ts", node => ts.isVariableDeclaration(node) && names.includes(node.name.getText()));
  assert.equal(matches.length, names.length);
  const canonical = { names: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz", fullName: "María del Mar De la Peña Muñoz" };
  const payload = { creditRiskExceptionId: exceptionId, analystDataRevision: 0 };
  const loaded = load(`exports.names = () => { ${matches.map(node => `const ${node.getText(tree)};`).join("\n")}
    return { clientePrimerNombre, clientePrimerApellido, clienteNombre, clienteApellidosVeriff }; };`, {
    readiness: { identity: { effective: canonical } }, draftPayload: payload,
    body: { clientePrimerNombre: "TAB ANTERIOR", clientePrimerApellido: "APELLIDO EDITADO" },
    sanitizeText: value => String(value ?? "").trim(),
  }, {});
  const recovered = loaded.names(); assert.equal(recovered.clientePrimerNombre, canonical.names);
  assert.equal(recovered.clientePrimerApellido, canonical.firstSurname); assert.equal(recovered.clienteNombre, canonical.fullName);
  assert.equal(recovered.clienteApellidosVeriff, "De la Peña Muñoz");
  delete payload.creditRiskExceptionId;
  assert.equal(loaded.names().clientePrimerNombre, "TAB ANTERIOR", "The ordinary structured flow keeps its existing behavior");
});

test("crear crédito y preparar FirmaSeguro respetan el techo excepcional aunque exista un cupo manual superior", async () => {
  for (const [file, globals] of [
    ["app/api/creditos/route.ts", { dataCreditoAssessment: { id: assessmentId },
      creditRiskAuthorization: { source: "INTERNAL_EXCEPTION" }, dataCreditoPolicyMaxFinancedAmount: 3500000,
      clienteDocumento: documentNumber }],
    ["lib/firmaseguro-draft-credit-builder.ts", { dataCreditoOffer: { authorizationSource: "INTERNAL_EXCEPTION", maxFinancedAmount: 3500000 },
      clienteDocumento: documentNumber }],
  ]) {
    const { tree, matches } = matchingNodes(file, node => ts.isVariableDeclaration(node) && node.name.getText() === "dataCreditoCreditLimit");
    assert.equal(matches.length, 1);
    let manualReads = 0;
    const loaded = load(`exports.limit = async () => { const ${matches[0].getText(tree)}; return dataCreditoCreditLimit; };`, {
      ...globals, resolveDataCreditoManualCreditLimit: async () => { manualReads++; return { maxFinancedAmount: 9000000 }; },
    }, {});
    assert.equal((await loaded.limit()).maxFinancedAmount, 3500000); assert.equal(manualReads, 0);
    if (globals.creditRiskAuthorization) globals.creditRiskAuthorization.source = "DATACREDITO";
    else globals.dataCreditoOffer.authorizationSource = "DATACREDITO";
    assert.equal((await loaded.limit()).maxFinancedAmount, 9000000); assert.equal(manualReads, 1);
  }
});

test("el cierre reserva exactamente la autoridad aplicable y no cae a otra si la excepción está ocupada", async () => {
  const { tree, matches } = matchingNodes("app/api/creditos/route.ts", node => ts.isIfStatement(node) &&
    (node.expression.getText().startsWith('creditRiskAuthorization?.source === "INTERNAL_EXCEPTION"') ||
      node.expression.getText().startsWith("dataCreditoAssessment && dataCreditoAssessmentMatch &&")));
  const nodes = matches.filter(node => node.getText(tree).includes("claimCreditRiskException") || node.getText(tree).includes("claimDataCreditoAssessment("));
  assert.equal(nodes.length, 2);
  const code = `exports.claim = async () => { let dataCreditoClaim = null; let creditRiskExceptionClaim = null;
    ${nodes.map(node => node.getText(tree)).join("\n")} return { dataCreditoClaim, creditRiskExceptionClaim }; };`;
  const calls = { internal: 0, normal: 0 }; let occupied = false;
  const raw = { id: assessmentId, status: "NO_EVALUADO", score: null };
  const authorization = { source: "INTERNAL_EXCEPTION", exceptionId };
  const loaded = load(code, {
    creditRiskAuthorization: authorization, dataCreditoAssessment: raw,
    dataCreditoAssessmentMatch: { assessmentId, documentNumber, firstSurname: "CONSULTADO", platform: "IPHONE", providerEnvironment: "production", ...scope },
    requestedSolicitudId: draftId, user: { id: 99 }, adminCentral: true,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    claimDataCreditoAssessment: async () => { calls.normal++; return { assessment: raw, claimToken: "normal-token" }; },
    recoverDataCreditoCredit: async () => null,
  }, { claimCreditRiskException: async input => {
    calls.internal++; assert.equal(input.solicitudId, draftId); assert.equal(input.exceptionId, exceptionId); assert.equal(input.actorUserId, 99);
    return occupied ? null : { claimToken: "internal-token" };
  } });
  const result = await loaded.claim(); assert.equal(result.creditRiskExceptionClaim.claimToken, "internal-token");
  assert.equal(result.dataCreditoClaim, null); assert.equal(calls.normal, 0);
  occupied = true; const denied = await loaded.claim(); assert.equal(denied.status, 409); assert.equal(calls.normal, 0);
  authorization.source = "DATACREDITO";
  const normal = await loaded.claim(); assert.equal(normal.dataCreditoClaim.claimToken, "normal-token");
  assert.equal(normal.creditRiskExceptionClaim, null); assert.equal(calls.normal, 1);
  assert.equal(raw.status, "NO_EVALUADO"); assert.equal(raw.score, null);
});

test("la excepción exige FirmaSeguro y conserva el comportamiento normal de firma", async () => {
  const { tree, matches } = matchingNodes("app/api/creditos/route.ts", node => ts.isIfStatement(node) &&
    node.getText().includes("CREDIT_RISK_EXCEPTION_SIGNATURE_REQUIRED"));
  const guard = matches.find(node => node.expression.getText().includes("!firmaSeguroPasoContratos"));
  assert.ok(guard);
  const authorization = { source: "INTERNAL_EXCEPTION" };
  const loaded = load(`exports.signature = async firmaSeguroPasoContratos => { ${guard.getText(tree)} return null; };`, {
    creditRiskAuthorization: authorization, NextResponse: { json: (body, init) => Response.json(body, init) },
  }, {});
  const denied = await loaded.signature(false); assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "CREDIT_RISK_EXCEPTION_SIGNATURE_REQUIRED");
  assert.equal(await loaded.signature(true), null);
  authorization.source = "DATACREDITO"; assert.equal(await loaded.signature(false), null);
});

test("el consumo y cierre son atómicos: un fallo al vincular la solicitud revierte la excepción", async t => {
  const { tree, matches } = matchingNodes("app/api/creditos/route.ts", node => ts.isIfStatement(node) && node.expression.getText() === "creditRiskExceptionClaim");
  const consumption = matches.find(node => node.getText(tree).includes("consumeCreditRiskException"));
  const closing = matchingNodes("app/api/creditos/route.ts", node => ts.isVariableDeclaration(node) && node.name.getText() === "linkedSolicitudId" &&
    node.initializer?.getText().startsWith("await completeSolicitudForCredit(")).matches[0];
  assert.ok(consumption && closing); assert.ok(consumption.pos < closing.pos, "Consume while the authoritative draft is still open");
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE TABLE lifecycle ("status" TEXT,"consumedCredit" INTEGER); INSERT INTO lifecycle VALUES (\'ABIERTO\',NULL)');
  let failClose = true;
  const claim = { match: { assessmentId, documentNumber, exceptionId, solicitudId: draftId, ...scope }, claimToken: "internal-token" };
  const loaded = load(`exports.finish = async transaction => { ${consumption.getText(tree)} const ${closing.getText(tree)}; return linkedSolicitudId; };`, {
    creditRiskExceptionClaim: claim, credit: { id: 101 }, solicitudReservation: { id: draftId }, dataCreditoAssessment: { id: assessmentId },
    clienteDocumento: documentNumber, imei: "123456789012345", plataformaDispositivo: "IPHONE",
    creditOwner: { usuarioId: scope.userId, vendedorId: scope.sellerId, sedeId: scope.sedeId },
    completeSolicitudForCredit: async (input, tx) => {
      assert.equal(input.solicitudId, draftId); assert.equal(input.creditoId, 101);
      if (failClose) throw new Error("SOLICITUD_COMPLETION_CONFLICT");
      await tx.query('UPDATE lifecycle SET "status"=\'CERRADO\''); return draftId;
    },
  }, { consumeCreditRiskException: async (input, tx) => {
    assert.equal(input.exceptionId, exceptionId); assert.equal(input.creditId, 101);
    const result = await tx.query('UPDATE lifecycle SET "consumedCredit"=$1 WHERE "status"=\'ABIERTO\' AND "consumedCredit" IS NULL RETURNING *', [input.creditId]);
    return result.rows.length === 1;
  } });
  await assert.rejects(db.transaction(tx => loaded.finish(tx)), /SOLICITUD_COMPLETION_CONFLICT/);
  assert.deepEqual((await db.query('SELECT * FROM lifecycle')).rows, [{ status: "ABIERTO", consumedCredit: null }]);
  failClose = false; assert.equal(await db.transaction(tx => loaded.finish(tx)), draftId);
  assert.deepEqual((await db.query('SELECT * FROM lifecycle')).rows, [{ status: "CERRADO", consumedCredit: 101 }]);
  await assert.rejects(db.transaction(tx => loaded.finish(tx)), /CREDIT_RISK_EXCEPTION_CONSUME_CONFLICT/);
});
