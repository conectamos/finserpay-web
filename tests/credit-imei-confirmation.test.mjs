import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
function load(path, mocks = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(read(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(code, { module: testModule, exports: testModule.exports, console, Date, Number,
    require: name => { assert.ok(name in mocks, "No external calls: " + name); return mocks[name]; },
  });
  return testModule.exports;
}
const core = load("lib/credit-imei-confirmation.ts");
const access = load("lib/solicitud-operation-access.ts");
const imei = "001234567890123";
const confirmation = { imei, confirmedAt: "2026-10-09T15:30:00.000Z", confirmedByUserId: 12, confirmedBySellerId: 34 };

test("IMEI incomplete, nonnumeric, whitespace, numeric JSON and mismatching text reject without normalizing", () => {
  for (const value of ["123", "00123456789012", "0012345678901234", "00123456789012X", " 001234567890123", 123456789012345, null]) {
    assert.throws(() => core.validateCreditImeiConfirmation(value, imei), error =>
      error.code === "IMEI_CONFIRMATION_INVALID" && error.message === "El IMEI debe contener exactamente 15 números.");
  }
  assert.throws(() => core.validateCreditImeiConfirmation("991234567890123", imei), error =>
    error.code === "IMEI_CONFIRMATION_MISMATCH" && error.message === "Los IMEI no coinciden. Revisa el número directamente en el equipo e inténtalo nuevamente.");
  assert.equal(core.validateCreditImeiConfirmation(imei, imei), imei);
});

test("autosave cannot forge, change, erase or resurrect confirmation audit", () => {
  const stored = { imeiConfirmation: confirmation, imeiConfirmationHistory: [confirmation] };
  const incoming = { imeiConfirmation: { ...confirmation, imei: "991234567890123", confirmedByUserId: 999 }, imeiConfirmationHistory: [], imeiConfirmationRequired: false, notes: "keep" };
  const merged = core.preserveCreditImeiConfirmation(stored, incoming, imei);
  assert.equal(merged.imeiConfirmation, confirmation);
  assert.equal(merged.imeiConfirmationHistory, stored.imeiConfirmationHistory);
  assert.equal(merged.notes, "keep");
  assert.equal("imeiConfirmationRequired" in merged, false);
  const changed = core.preserveCreditImeiConfirmation(stored, incoming, "991234567890123");
  assert.equal("imeiConfirmation" in changed, false);
  assert.equal(changed.imeiConfirmationHistory.length, 1);
  assert.equal("imeiConfirmation" in core.preserveCreditImeiConfirmation({}, incoming, imei), false);
});

test("only the current legacy contract with the exact IMEI is compatible", () => {
  const currentProcess = { processUuid: "current", draftPayload: { imei, deviceUid: imei } };
  assert.equal(core.hasCurrentContractImeiConfirmation({ imei, payload: {}, currentProcess }), true);
  for (const process of [null, { ...currentProcess, supersededAt: "2026-10-09" },
    { ...currentProcess, draftPayload: { imei: "991234567890123" } },
    { ...currentProcess, draftPayload: { imei, deviceUid: "991234567890123" } }]) {
    assert.equal(core.hasCurrentContractImeiConfirmation({ imei, payload: {}, currentProcess: process }), false);
  }
  assert.equal(core.hasCurrentContractImeiConfirmation({ imei, payload: { imeiConfirmation: { ...confirmation, imei: "991234567890123" } }, currentProcess }), false);
  assert.equal(core.hasCurrentContractImeiConfirmation({ imei, payload: { imeiConfirmation: confirmation } }), true);
});

function fixture() {
  const state = { id: 90, imei, payload: {}, vendedorId: 34, aliadoId: 56, closed: false, process: null, writes: [], locks: [], reads: [] };
  const database = {
    async $queryRawUnsafe(sql) {
      state.reads.push(sql);
      if (sql.includes('FROM "CreditoBorrador"')) return state.closed ? [] : [{ ...state }];
      if (sql.includes('FROM "FirmaSeguroProcess"')) return state.process ? [state.process] : [];
      assert.fail("Unexpected SQL: " + sql);
    },
    async $executeRawUnsafe(sql, id, payload, expectedImei) {
      assert.match(sql, /"imei"=\$3/); assert.equal(id, state.id); assert.equal(expectedImei, state.imei);
      state.payload = JSON.parse(payload); state.writes.push(state.payload); return 1;
    },
  };
  let queue = Promise.resolve();
  const prisma = { ...database, $transaction(callback) { const pending = queue.then(() => callback(database)); queue = pending.catch(() => {}); return pending; } };
  const functions = load("lib/credit-imei-confirmation-storage.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-imei-confirmation": core,
    "@/lib/solicitud-operation-access": access,
    "@/lib/firmaseguro-storage": { async lockSolicitudOperationMutation(_database, id) { state.locks.push(id); } },
  });
  const input = { draftId: 90, enteredImei: imei, userId: 12, central: false, viewerAllyId: 56, seller: { id: 34, tipoPerfil: "VENDEDOR" } };
  return { state, functions, input, database };
}

test("confirmation persists current IMEI, user, seller and date; concurrent repeated requests audit once", async () => {
  const f = fixture();
  const [first, duplicate] = await Promise.all([f.functions.confirmDraftImei(f.input), f.functions.confirmDraftImei(f.input)]);
  assert.equal(first.confirmation.imei, imei); assert.equal(first.confirmation.confirmedByUserId, 12);
  assert.equal(first.confirmation.confirmedBySellerId, 34); assert.ok(Date.parse(first.confirmation.confirmedAt));
  assert.equal(first.idempotent, false); assert.equal(duplicate.idempotent, true);
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.payload.imeiConfirmationHistory.length, 1);
  assert.deepEqual(f.state.locks, [90, 90]);
  assert.equal(f.state.imei, imei, "Confirmation never edits the protected device identifier");
  await f.functions.requireDraftImeiConfirmation(90, f.database);
});

test("changed IMEI invalidates previous acknowledgement, requires fresh reentry and keeps history", async () => {
  const f = fixture(); await f.functions.confirmDraftImei(f.input);
  f.state.imei = "991234567890123";
  f.state.payload = core.preserveCreditImeiConfirmation(f.state.payload, {}, f.state.imei);
  await assert.rejects(f.functions.requireDraftImeiConfirmation(90, f.database), error => error.code === "IMEI_CONFIRMATION_REQUIRED");
  await assert.rejects(f.functions.confirmDraftImei(f.input), error => error.code === "IMEI_CONFIRMATION_MISMATCH");
  assert.equal(f.state.writes.length, 1);
  const second = await f.functions.confirmDraftImei({ ...f.input, enteredImei: f.state.imei });
  assert.equal(second.idempotent, false); assert.equal(second.confirmation.imei, "991234567890123");
  assert.equal(f.state.payload.imeiConfirmationHistory.length, 2);
});

test("ownership, ally, profile and open-state checks prevent confirming another request", async () => {
  for (const override of [{ seller: { id: 35, tipoPerfil: "VENDEDOR" } }, { viewerAllyId: 57 }, { seller: { id: 34, tipoPerfil: "RECAUDADOR" } }]) {
    const f = fixture(); await assert.rejects(f.functions.confirmDraftImei({ ...f.input, ...override }), /SOLICITUD_NO_AUTORIZADA/);
    assert.equal(f.state.writes.length, 0);
  }
  const f = fixture(); f.state.closed = true;
  await assert.rejects(f.functions.confirmDraftImei(f.input), /SOLICITUD_NO_AUTORIZADA/);
  assert.equal(f.state.writes.length, 0);
  const central = fixture(); await central.functions.confirmDraftImei({ ...central.input, central: true, seller: null });
  assert.equal(central.state.payload.imeiConfirmation.confirmedBySellerId, null);
});

test("a different authorized confirmer records their own audit without duplicating the original", async () => {
  const f = fixture(); await f.functions.confirmDraftImei(f.input);
  const result = await f.functions.confirmDraftImei({ ...f.input, central: true, userId: 99, seller: null });
  assert.equal(result.idempotent, false); assert.equal(result.confirmation.confirmedByUserId, 99);
  assert.equal(f.state.payload.imeiConfirmationHistory.length, 2);
  assert.equal(f.state.payload.imeiConfirmationHistory[0].confirmedByUserId, 12);
});

test("confirmation HTTP endpoint authenticates, rejects unprivileged admins and returns validation errors", async () => {
  const f = fixture();
  let user = { id: 12, aliadoId: 56, rolNombre: "ASESOR", aliadoAccesoCodigo: "ALIADO" };
  const route = load("app/api/creditos/borradores/[id]/confirmar-imei/route.ts", {
    "next/server": { NextResponse: { json: (data, options = {}) => ({ data, status: options.status || 200 }) } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": { isFinserPayCentralAlly: value => value === "FINSERPAY" },
    "@/lib/roles": { isAdminRole: value => value === "ADMIN" },
    "@/lib/seller-auth": { getSellerSessionUser: async () => f.input.seller },
    "@/lib/solicitud-operation-access": access,
    "@/lib/credit-imei-confirmation": core,
    "@/lib/credit-imei-confirmation-storage": f.functions,
  });
  const send = body => route.POST({ json: async () => body }, { params: Promise.resolve({ id: "90" }) });
  user = null; assert.equal((await send({ imei })).status, 401);
  user = { id: 12, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoId: 56 };
  assert.equal((await send({ imei })).status, 403); assert.equal(f.state.writes.length, 0);
  user = { id: 12, rolNombre: "ASESOR", aliadoId: 56 };
  const invalid = await send(null); assert.equal(invalid.status, 400); assert.equal(invalid.data.code, "IMEI_CONFIRMATION_INVALID");
  const mismatch = await send({ imei: "991234567890123" }); assert.equal(mismatch.status, 409); assert.equal(mismatch.data.code, "IMEI_CONFIRMATION_MISMATCH");
  const valid = await send({ imei }); assert.equal(valid.status, 200); assert.equal(valid.data.confirmation.imei, imei);
  assert.equal(f.state.writes.length, 1);
});

test("draft POST rejects malformed forward IMEIs before fallback to a previously confirmed identifier", async () => {
  const source = read("app/api/creditos/borradores/route.ts");
  const ast = ts.createSourceFile("drafts.ts", source, ts.ScriptTarget.Latest, true);
  const post = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "POST");
  assert.ok(post);
  const saves = [];
  const context = {
    ...core, console,
    NextResponse: { json: (data, options = {}) => ({ data, status: options.status || 200 }) },
    getAccess: async () => ({ central: true, user: { id: 12, sedeId: 3, aliadoId: 56 }, seller: null }),
    expireStaleSolicitudes: async () => {}, ensureVeriffSchema: async () => {}, ensureFirmaSeguroSchema: async () => {},
    normalizePayload: value => structuredClone(value || {}),
    sanitizeText: value => String(value || "").trim(),
    clampStep: value => Math.max(1, Math.min(5, Number(value) || 1)),
    parsePositiveId: value => Number(value) || null,
    extractDraftFields: payload => payload,
    getActiveSolicitudCreditContext: async () => ({ id: 90, currentStep: 4, imei, payload: { imeiConfirmation: confirmation }, usuarioId: 12, vendedorId: 34, sedeId: 3 }),
    canOperateSolicitud: () => true, assertDocumentNotBlacklisted: async () => {},
    prisma: { $queryRawUnsafe: async () => [{ signed: true }] },
    requiresCreditClientStepValidation: () => false,
    saveSolicitudDraft: async input => { saves.push(input); return { id: 90 }; },
    readDrafts: async () => [{ id: 90, payload: saves.at(-1).payload }], serializeDraft: row => row,
    documentBlacklistErrorResponse: () => null,
    module: { exports: {} }, exports: {},
  };
  runInNewContext(ts.transpileModule(post.getText(ast), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, context);
  const send = (payload, currentStep = 4, payloadScope = "FULL") => context.exports.POST({
    json: async () => ({ id: 90, currentStep, payloadScope, payload }),
  });
  for (const field of ["imei", "deviceUid"]) {
    for (const malformed of ["00123456789012", "0012345678901234", "001234567890123456789012", "X001234567890123", "00123456789012X", " 001234567890123", 123456789012345, null, ""]) {
      for (const currentStep of [3, 4, 5]) {
        const result = await send({ [field]: malformed }, currentStep);
        assert.equal(result.status, 400, `${field}, step ${currentStep}, ${JSON.stringify(malformed)}`);
        assert.equal(result.data.code, "IMEI_CONFIRMATION_INVALID");
      }
    }
  }
  assert.equal(saves.length, 0, "An old confirmation never authorizes a malformed submitted identifier");
  const valid = await send({ imei, deviceUid: imei });
  assert.equal(valid.status, 200);
  assert.equal(saves[0].payload.imei, imei, "Leading zeros remain text");
  for (const currentStep of [1, 2]) {
    for (const partial of ["", "00123456789012", "0012345678901234"]) {
      assert.equal((await send({ imei: partial, deviceUid: partial }, currentStep)).status, 200);
      assert.equal(saves.at(-1).payload.imei, partial, "Partial input can still be saved without advancing");
    }
  }
  assert.equal((await send({ fotoEntregaDataUrl: "existing" }, 5, "DELIVERY_EVIDENCE")).status, 200,
    "A signed evidence-only autosave can omit equipment identifiers");
});

test("server guard blocks unconfirmed/new versions and allows an existing bound current contract", async () => {
  const f = fixture();
  await assert.rejects(f.functions.requireDraftImeiConfirmation(90, f.database), error => error.code === "IMEI_CONFIRMATION_REQUIRED");
  f.state.process = { processUuid: "legacy", draftPayload: { imei, deviceUid: imei } };
  await f.functions.requireDraftImeiConfirmation(90, f.database);
  f.state.imei = "991234567890123";
  await assert.rejects(f.functions.requireDraftImeiConfirmation(90, f.database), error => error.code === "IMEI_CONFIRMATION_REQUIRED");
});

test("real autosave guard rejects forged advance to identity and resets direct restored progress", () => {
  const source = read("lib/solicitudes-storage.ts");
  const start = source.indexOf("canonicalPayload = preserveCreditImeiConfirmation");
  const end = source.indexOf("if (canonicalImei)", start);
  assert.ok(start > 0 && end > start);
  const code = "{ " + source.slice(start, end) + "\nresult = { canonicalPayload, imeiVerifiedStep }; }";
  for (const step of [3, 4, 5]) {
    const context = { ...core, canonicalPayload: { imeiConfirmation: confirmation }, targetRow: { payload: {} }, canonicalImei: imei, firmaSeguroTerms: null, incomingStep: step, persistedStep: step };
    assert.throws(() => runInNewContext(code, context), error => error.code === "IMEI_CONFIRMATION_REQUIRED");
  }
  const context = { ...core, canonicalPayload: {}, targetRow: { payload: {} }, canonicalImei: imei, firmaSeguroTerms: null, incomingStep: 2, persistedStep: 5 };
  runInNewContext(code, context); assert.equal(context.result.imeiVerifiedStep, 2);
  context.incomingStep = 1; context.persistedStep = 1;
  runInNewContext(code, context); assert.equal(context.result.imeiVerifiedStep, 1, "An unconfirmed Client draft must not skip to Equipment");
  context.targetRow.payload = { imeiConfirmation: confirmation }; context.incomingStep = 4;
  context.persistedStep = 5;
  runInNewContext(code, context); assert.equal(context.result.imeiVerifiedStep, 5);
  assert.match(source, /WHEN \$11::boolean THEN \$2/);
});

test("actual restore serialization caps stale progress at Equipo without fabricating confirmation", () => {
  const source = read("app/api/creditos/borradores/route.ts");
  const ast = ts.createSourceFile("drafts.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "serializeDraft");
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(ast) + "\nresult = serializeDraft(row)", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const row = { id: 90, imei, currentStep: 4, payload: { wizardStep: 4 }, createdAt: null, updatedAt: null, closedAt: null };
  const context = { ...core, row, clampStep: value => Math.max(1, Math.min(5, Number(value) || 1)), toDateIso: value => value, isFirmaSeguroSuccessfulStatus: () => true };
  runInNewContext(code, context); assert.equal(context.result.currentStep, 2);
  assert.equal(context.result.payload.wizardStep, 2); assert.equal(context.result.payload.imeiConfirmationRequired, true);
  row.payload.imeiConfirmation = confirmation;
  runInNewContext(code, context); assert.equal(context.result.currentStep, 4); assert.equal(context.result.payload.imeiConfirmationRequired, false);
  row.firmaProcessUuid = "current-signed"; row.firmaStatus = "SIGNED";
  row.firmaDraftPayload = { imei, deviceUid: imei };
  runInNewContext(code, context); assert.equal(context.result.currentStep, 4, "The signed webhook enables delivery but never auto-advances");
  row.currentStep = 5; row.payload.wizardStep = 5;
  runInNewContext(code, context); assert.equal(context.result.currentStep, 5, "Explicitly entered delivery remains resumable");
});

test("mutation guards run under existing operation locks and before provider/financial side effects", () => {
  const veriff = read("app/api/creditos/veriff/route.ts");
  assert.ok(veriff.indexOf("await requireDraftImeiConfirmation(draftId)") > veriff.indexOf("await tryAcquireSolicitudOperationLock(draftId)"));
  assert.ok(veriff.indexOf("await requireDraftImeiConfirmation(draftId)") < veriff.indexOf("await veriffCreateSession("));
  const firma = read("app/api/creditos/borradores/[id]/firma-seguro/route.ts");
  assert.ok(firma.indexOf("await requireDraftImeiConfirmation(draftId)") > firma.indexOf("await tryAcquireFirmaSeguroDraftDispatchLock(draftId)"));
  assert.ok(firma.indexOf("await requireDraftImeiConfirmation(draftId)") < firma.indexOf("await reserveDraftDispatch("));
  const close = read("app/api/creditos/route.ts");
  assert.ok(close.indexOf("await requireDraftImeiConfirmation(requestedSolicitudId)") > close.indexOf("await tryAcquireSolicitudOperationLock(requestedSolicitudId)"));
  assert.ok(close.indexOf("await requireDraftImeiConfirmation(solicitudReservation.id)") < close.indexOf("const createCreditWithAmortization"));
  assert.match(read("lib/firmaseguro-imei-correction.ts"), /delete nextPayload\.imeiConfirmation/);
});
