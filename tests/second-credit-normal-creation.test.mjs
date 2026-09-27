import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/api/creditos/route.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let creationDeclaration;
let eligibilityErrorBranch;
function collect(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "createCreditWithAmortization") creationDeclaration = node;
  if (ts.isIfStatement(node) && node.expression.getText(parsed) === "error instanceof SecondCreditAuthorizationError") eligibilityErrorBranch = node;
  ts.forEachChild(node, collect);
}
collect(parsed);
assert.ok(creationDeclaration, "The test must execute the real final creation closure");
assert.ok(eligibilityErrorBranch);

function evaluate(code, globals) {
  const output = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports, console, Date, ...globals }, { filename: "normal-second-credit-fixture.cjs" });
  return exports;
}

class EligibilityError extends Error {
  constructor(code) {
    super(code === "SECOND_CREDIT_LIMIT_REACHED"
      ? "La cédula ya tiene dos créditos vigentes."
      : "La cédula requiere autorización del administrador central para un segundo crédito.");
    this.code = code;
    this.status = 409;
  }
}

const authorization = {
  id: "auth-second-credit", documento: "1065845982", version: 1,
  reason: "Autorizado por administración", authorizedByName: "Administrador central",
  authorizedAt: "2026-09-27T12:00:00.000Z", activeCreditIds: [91], activeFolios: ["FC-91"],
};
const snapshot = {
  financiero: { sello: { checksum: "signed-financing-checksum" }, montoCredito: 2_000_000, valorCuota: 99_800 },
  evidencia: { identidad: { id: "previous-validation" }, foto: "preserved-photo" },
  clausulas: ["Contrato vigente"],
};
const originalArgs = {
  data: { folio: "FC-92", clienteDocumento: "1065845982", montoCredito: 2_000_000, valorCuota: 99_800, contratoSnapshot: snapshot },
  include: { vendedor: true }, omit: { equalityPayload: true },
};
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({ state = { activeCredits: 1, authorized: true }, veriff = null, blocked = false, blacklistGuard = null } = {}) {
  const activity = [];
  const transaction = {
    credito: {
      create: async args => { activity.push("create"); state.activeCredits += 1; return { id: 92, ...clone(args.data) }; },
    },
    $queryRawUnsafe: async () => [veriff],
  };
  const globals = {
    clienteDocumento: "1065845982", imei: "355190874496946", plataformaDispositivo: "IPHONE",
    solicitudReservation: { id: 7 }, creditOwner: { usuarioId: 3, vendedorId: 4, sedeId: 5 },
    creditCreateArgs: clone(originalArgs), contratoSnapshot: clone(snapshot),
    veriffValidation: veriff, firmaSeguroProcess: null, dataCreditoAssessment: null,
    amortizationPersistencePlan: { cuotaComercial: 99_800 }, amortizationParametersSnapshot: { financialTermsChecksum: "signed-financing-checksum" },
    assertDocumentNotBlacklisted: async (document, tx) => {
      assert.equal(document, "1065845982"); assert.equal(tx, transaction);
      activity.push("blacklist-document-lock");
      if (blacklistGuard) await blacklistGuard(tx);
      if (blocked) throw Object.assign(new Error("Documento bloqueado"), { code: "DOCUMENT_BLACKLISTED" });
    },
    assertSecondCreditEligibility: async (tx, document) => {
      assert.equal(tx, transaction); assert.equal(document, "1065845982"); activity.push("eligibility");
      if (state.activeCredits >= 2) throw new EligibilityError("SECOND_CREDIT_LIMIT_REACHED");
      if (state.activeCredits === 1 && !state.authorized) throw new EligibilityError("ACTIVE_CREDIT_EXISTS");
      return state.activeCredits === 1 ? clone(authorization) : null;
    },
    lockCreditDeviceReplacementImeiForCreditCreation: async tx => { assert.equal(tx, transaction); activity.push("device-lock"); },
    lockVeriffDraftAttempts: async tx => { assert.equal(tx, transaction); activity.push("identity-lock"); },
    isVeriffApproved: () => true,
    buildVeriffSnapshot: value => ({ id: value.id, decision: "approved" }),
    linkVeriffValidationToCredit: async (id, creditId, tx) => { assert.equal(tx, transaction); activity.push("link-veriff"); return veriff; },
    persistCreditAmortization: async (tx, id, plan, parameters) => {
      assert.equal(tx, transaction); assert.equal(id, 92); assert.equal(plan.cuotaComercial, 99_800);
      assert.equal(parameters.financialTermsChecksum, "signed-financing-checksum"); activity.push("amortization");
    },
    completeSolicitudForCredit: async (input, tx) => {
      assert.equal(tx, transaction); assert.equal(input.creditoId, 92); assert.equal(input.solicitudId, 7);
      activity.push("complete-solicitud"); return 7;
    },
  };
  const { create } = evaluate(`const ${creationDeclaration.getText(parsed)}; exports.create = createCreditWithAmortization;`, globals);
  return { create: () => create(transaction), activity, transaction };
}

test("sin autorización vigente, el cierre revalida bajo el lock antes de bloquear IMEI o crear", async () => {
  const { create, activity } = fixture({ state: { activeCredits: 1, authorized: false } });
  await assert.rejects(create(), error => error.code === "ACTIVE_CREDIT_EXISTS");
  assert.deepEqual(activity, ["blacklist-document-lock", "eligibility"]);
});

test("una autorización del segundo crédito nunca permite un tercer crédito", async () => {
  const { create, activity } = fixture({ state: { activeCredits: 2, authorized: true } });
  await assert.rejects(create(), error => error.code === "SECOND_CREDIT_LIMIT_REACHED");
  assert.deepEqual(activity, ["blacklist-document-lock", "eligibility"]);
});

test("la autorización no omite el bloqueo de lista negra", async () => {
  const { create, activity } = fixture({ blocked: true });
  await assert.rejects(create(), error => error.code === "DOCUMENT_BLACKLISTED");
  assert.deepEqual(activity, ["blacklist-document-lock"]);
});

test("un primer crédito conserva sus datos y no se registra como excepción administrativa", async () => {
  const { create, activity } = fixture({ state: { activeCredits: 0, authorized: false } });
  const result = await create();
  assert.deepEqual(result.credit, { id: 92, ...clone(originalArgs.data) });
  assert.equal(Object.hasOwn(result.credit.contratoSnapshot, "segundoCreditoAutorizacion"), false);
  assert.deepEqual(activity, ["blacklist-document-lock", "eligibility", "device-lock", "create", "amortization", "complete-solicitud"]);
});

test("un segundo crédito conserva monto, cuota, sello y evidencia, y guarda la autorización realmente revalidada", async () => {
  const { create } = fixture();
  const result = await create();
  assert.equal(result.credit.montoCredito, 2_000_000);
  assert.equal(result.credit.valorCuota, 99_800);
  assert.deepEqual(result.credit.contratoSnapshot.financiero, clone(snapshot.financiero));
  assert.deepEqual(result.credit.contratoSnapshot.evidencia, clone(snapshot.evidencia));
  assert.deepEqual(result.credit.contratoSnapshot.segundoCreditoAutorizacion, clone(authorization));
  assert.deepEqual(result.credit.contratoSnapshot.clausulas, clone(snapshot.clausulas));
});

test("la evidencia Veriff vigente sigue vinculada al segundo crédito sin cambiar el sello financiero", async () => {
  const veriff = { id: "fresh-identity-validation", creditoId: null };
  const { create, activity } = fixture({ veriff });
  const result = await create();
  assert.deepEqual(result.credit.contratoSnapshot.evidencia, { identidad: { id: veriff.id, decision: "approved" }, foto: "preserved-photo" });
  assert.deepEqual(result.credit.contratoSnapshot.financiero, clone(snapshot.financiero));
  assert.deepEqual(result.credit.contratoSnapshot.segundoCreditoAutorizacion, clone(authorization));
  assert.ok(activity.indexOf("eligibility") < activity.indexOf("identity-lock"));
  assert.ok(activity.indexOf("create") < activity.indexOf("link-veriff"));
});

test("dos cierres concurrentes con un crédito activo dejan crear sólo el segundo bajo el lock por cédula", async () => {
  const state = { activeCredits: 1, authorized: true };
  let tail = Promise.resolve();
  const releases = new Map();
  async function lock(tx) {
    const prior = tail;
    tail = new Promise(resolve => releases.set(tx, resolve));
    await prior;
  }
  const first = fixture({ state, blacklistGuard: lock });
  const second = fixture({ state, blacklistGuard: lock });
  const execute = async fixture => {
    try { return await fixture.create(); }
    finally { releases.get(fixture.transaction)?.(); }
  };
  const results = await Promise.allSettled([execute(first), execute(second)]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.find(item => item.status === "rejected").reason.code, "SECOND_CREDIT_LIMIT_REACHED");
  assert.equal(state.activeCredits, 2);
  assert.equal([...first.activity, ...second.activity].filter(item => item === "create").length, 1);
});

test("la prevalidación usa la nueva autorización y el cierre devuelve errores funcionales explícitos", async () => {
  const start = source.indexOf("    await ensureSecondCreditAuthorizationSchema();");
  const end = source.indexOf("    if (!equipoMarca || !equipoModelo)", start);
  assert.ok(start > 0 && end > start);
  const section = source.slice(start, end);
  const database = {};
  const calls = [];
  const { prevalidate, errorResponse } = evaluate(`
    async function prevalidate() { ${section} }
    function errorResponse(error) { ${eligibilityErrorBranch.getText(parsed)} }
    exports.prevalidate = prevalidate; exports.errorResponse = errorResponse;
  `, {
    prisma: database, clienteDocumento: "1065845982", SecondCreditAuthorizationError: EligibilityError,
    ensureSecondCreditAuthorizationSchema: async () => calls.push("schema"),
    assertSecondCreditEligibility: async (db, document) => {
      assert.equal(db, database); assert.equal(document, "1065845982"); calls.push("eligibility");
      throw new EligibilityError("ACTIVE_CREDIT_EXISTS");
    },
    NextResponse: { json: (body, init) => ({ body, status: init.status }) },
  });
  await assert.rejects(prevalidate(), error => error.code === "ACTIVE_CREDIT_EXISTS");
  assert.deepEqual(calls, ["schema", "eligibility"]);
  for (const code of ["ACTIVE_CREDIT_EXISTS", "SECOND_CREDIT_LIMIT_REACHED"]) {
    const response = errorResponse(new EligibilityError(code));
    assert.equal(response.status, 409); assert.equal(response.body.code, code); assert.ok(response.body.error);
  }
});

test("el reintento de una solicitud ya finalizada recupera el crédito aunque ya tenga dos vigentes o se revoque la autorización", async () => {
  const names = ["POST", "finalizedSolicitudRecoveredCreditResponse"];
  const declarations = names.map(name => {
    const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node); return node.getText(parsed).replace(/^export\s+/, "");
  });
  const calls = [];
  const { POST } = evaluate(`${declarations.join("\n")}\nexports.POST = POST;`, {
    Request, Response,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    getSessionUser: async () => ({ id: 1, rolNombre: "ADMIN", aliadoId: 1, aliadoAccesoCodigo: "FINSER_PAY" }),
    isAdminRole: () => true, isFinserPayCentralAlly: () => true,
    sanitizeText: value => String(value || "").trim(),
    toNullableDate: () => null, parseId: value => value ? Number(value) : null,
    getActiveSolicitudCreditContext: async () => null,
    getFinalizedSolicitudCreditContext: async () => ({ id: 7, creditoId: 92, clienteDocumento: "1065845982" }),
    canOperateSolicitudContext: () => true,
    documentValuesMatch: (left, right) => String(left).replace(/\D/g, "") === String(right).replace(/\D/g, ""),
    prisma: { credito: {
      findUnique: async ({ where }) => { assert.equal(where.id, 92); calls.push("read-existing"); return { id: 92, folio: "FC-92" }; },
      create: async () => { throw new Error("A replay must not create a new credit"); },
    } },
    creditListInclude: {}, creditListOmit: {}, serializeCredit: clone,
    ensureSecondCreditAuthorizationSchema: async () => { throw new Error("A replay must not depend on a new authorization"); },
    assertSecondCreditEligibility: async () => { throw new Error("A replay must not consume another slot"); },
    assertDocumentNotBlacklisted: async () => { throw new Error("A replay must not create a new sale"); },
  });
  const response = await POST(new Request("https://fixture.test/api/creditos", {
    method: "POST", body: JSON.stringify({ solicitudId: 7, clienteDocumento: "1065845982" }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recovered, true); assert.equal(body.item.id, 92);
  assert.deepEqual(body.solicitud, { id: 7, estado: "CERRADO", creditoId: 92 });
  assert.deepEqual(calls, ["read-existing"]);
});
