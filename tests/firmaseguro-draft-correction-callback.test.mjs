import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const version = loadReissueModule("lib/firmaseguro-draft-correction-version.ts");
const id = "10000000-0000-4000-8000-000000000001";
const imei = "001234567890123";
const pdf = Buffer.from("%PDF-1.4\nSIGNED TEST ONLY\n%%EOF").toString("base64");
const process = { draftId: 22, creditoId: null, processUuid: "current", supersededAt: null,
  completedAt: new Date(), signedDocumentBase64: pdf, status: "COMPLETED",
  draftPayload: { imei, clienteNombre: "CLIENTE CORRECTO", firmaSeguroCorrectionId: id,
    firmaSeguroFinancialCorrectionId: id, firmaSeguroIdentityCorrectionId: id, financialTermsSeal: {} } };
function completion(calls) {
  return loadReissueModule("lib/firmaseguro-draft-correction-complete.ts", {
    "@/lib/firmaseguro-imei-correction": { recordFirmaSeguroImeiCorrectionReissue: async (...args) => calls.push(["imei", ...args]) },
    "@/lib/firmaseguro-financial-correction": { recordFirmaSeguroFinancialCorrectionReissue: async (...args) => calls.push(["financial", ...args]) },
    "@/lib/firmaseguro-draft-identity-correction": { recordSignedDraftIdentityCorrectionReissue: async (...args) => calls.push(["identity", ...args]) },
  }).recordVerifiedDraftCorrectionReissues;
}

test("callback completion requires a current draft, completion date and actual PDF", async () => {
  const calls = []; const complete = completion(calls);
  for (const invalid of [null, { ...process, draftId: null }, { ...process, creditoId: 1 },
    { ...process, supersededAt: new Date() }, { ...process, completedAt: null },
    { ...process, signedDocumentBase64: null }, { ...process, signedDocumentBase64: Buffer.from("<html>").toString("base64") }]) {
    await complete(invalid);
  }
  assert.equal(calls.length, 0);
  await complete(process);
  assert.deepEqual(calls.map(call => call[0]), ["imei", "financial", "identity"]);
  for (const call of calls) { assert.equal(call[1], 22); assert.equal(call[2], process); }
});

test("the callback records only after authenticated provider refresh, ignoring its untrusted claimed status", async () => {
  const calls = []; const record = completion(calls);
  let verified = { ...process, completedAt: null, signedDocumentBase64: null };
  const callback = loadReissueModule("app/api/firma-seguro/callback/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/firmaseguro": { getFirmaSeguroConfig: () => ({ callbackSecret: "test-secret" }),
      extractFirmaSeguroUuid: body => body.uuid, extractFirmaSeguroStatus: body => body.status },
    "@/lib/firmaseguro-credit": { getFirmaSeguroProcessForCallback: async () => process,
      refreshFirmaSeguroProcess: async () => { calls.push(["refresh"]); return verified; }, serializeFirmaSeguroProcess: value => value },
    "@/lib/firmaseguro-storage": { updateFirmaSeguroProcess: async () => process },
    "@/lib/firmaseguro-draft-dispatch-ledger": {},
    "@/lib/firmaseguro-draft-correction-complete": { recordVerifiedDraftCorrectionReissues: record },
  });
  const send = token => callback.POST(new Request("https://example.invalid/callback", {
    method: "POST", headers: { "Content-Type": "application/json", "x-firmaseguro-token": token },
    body: JSON.stringify({ uuid: "current", status: "COMPLETED" }),
  }));
  assert.equal((await send("wrong")).status, 401); assert.equal(calls.length, 0);
  assert.equal((await send("test-secret")).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ["refresh"]);
  verified = process;
  assert.equal((await send("test-secret")).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ["refresh", "refresh", "imei", "financial", "identity"]);
});

function recorderFixture(kind, currentUuid = "current") {
  const definitions = {
    imei: ["lib/firmaseguro-imei-correction.ts", "recordFirmaSeguroImeiCorrectionReissue"],
    financial: ["lib/firmaseguro-financial-correction.ts", "recordFirmaSeguroFinancialCorrectionReissue"],
    identity: ["lib/firmaseguro-draft-identity-correction.ts", "recordSignedDraftIdentityCorrectionReissue"],
  };
  const [path, name] = definitions[kind];
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  const state = { currentUuid, inserts: 0, updates: 0, locked: false,
    payload: { firmaSeguroCorrectionPending: true, firmaSeguroCorrectionId: id,
      firmaSeguroFinancialCorrectionPending: true, firmaSeguroFinancialCorrectionId: id,
      firmaSeguroIdentityCorrectionPending: true, firmaSeguroIdentityCorrectionId: id,
      fotoRemisionDataUrl: "saved-new-remission", fotoEntregaDataUrl: "saved-delivery" } };
  const corrected = { correlationId: id, draftId: 22, newImei: imei, previousImei: "991234567890123",
    newName: "CLIENTE CORRECTO", previousName: "ANTERIOR", actorUserId: 7, actorName: "Analista", reason: "Corrección comprobada", previousProcessUuid: "previous" };
  const database = {
    async $queryRawUnsafe(sql) {
      assert.equal(state.locked, true, "Version checks and audits must hold the operation lock");
      if (sql.includes('FROM "FirmaSeguroProcess" process')) {
        assert.match(sql, /"supersededAt" IS NULL/); assert.match(sql, /draft\."estado"='ABIERTO'/);
        assert.match(sql, /"expiresAt"/); return state.currentUuid ? [{ processUuid: state.currentUuid }] : [];
      }
      if (sql.includes("'REISSUED'")) return state.inserts ? [{ newProcessUuid: "current" }] : [];
      if (sql.includes("'CORRECTED'")) return [corrected];
      assert.fail(sql);
    },
    async $executeRawUnsafe(sql) {
      if (sql.includes("INSERT INTO")) { assert.match(sql, /ON CONFLICT/); state.inserts = 1; return 1; }
      if (sql.includes('UPDATE "CreditoBorrador"')) {
        state.updates++;
        if (kind === "imei") { delete state.payload.firmaSeguroCorrectionPending; delete state.payload.firmaSeguroCorrectionId; }
        if (kind === "financial") { delete state.payload.firmaSeguroFinancialCorrectionPending; delete state.payload.firmaSeguroFinancialCorrectionId; }
        if (kind === "identity") { delete state.payload.firmaSeguroIdentityCorrectionPending; delete state.payload.firmaSeguroIdentityCorrectionId; }
        return 1;
      }
      assert.fail(sql);
    },
  };
  const record = value => value && typeof value === "object" ? value : {};
  const globals = {
    Buffer, Date, ...version, record, payloadObject: record,
    UUID: /^[a-f0-9-]{36}$/i, UUID_PATTERN: /^[a-f0-9-]{36}$/i,
    normalizeImei: value => String(value || ""), normalizeCorrectionId: value => String(value || ""),
    cleanText: value => String(value || ""), moneyFromSeal: value => Number(value),
    readFinancingTermsSeal: () => ({ checksum: "a".repeat(64), snapshot: {
      clienteNombre: "CLIENTE CORRECTO", valorVenta: "1000000", cuotaInicial: "200000", numeroCuotas: 12 } }),
    hasSignedPdf: value => Boolean(value.completedAt && value.signedDocumentBase64),
    ensureFirmaSeguroSchema: async () => {}, ensureFirmaSeguroFinancialCorrectionSchema: async () => {},
    ensureSignedDraftIdentityCorrectionSchema: async () => {},
    lockSolicitudOperationMutation: async () => { state.locked = true; },
    prisma: { $transaction: callback => callback(database) },
    draft: async () => ({ id: 22, clienteNombre: "CLIENTE CORRECTO", payload: state.payload }),
    compare: value => String(value || ""), correctionError: () => new Error("conflict"),
    randomUUID: () => "20000000-0000-4000-8000-000000000002",
  };
  const fn = runInNewContext(ts.transpileModule(declaration.getText(ast).replace(/^export /, "") + "\n" + name,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, globals);
  return { state, invoke: value => fn(22, value) };
}

for (const kind of ["imei", "financial", "identity"]) {
  test(`${kind}: a stale callback snapshot cannot clear a newer version or append an incorrect audit`, async () => {
    for (const uuid of ["newer-version", null]) {
      const f = recorderFixture(kind, uuid);
      assert.equal(await f.invoke(process), false);
      assert.equal(f.state.inserts, 0); assert.equal(f.state.updates, 0);
      assert.equal(f.state.payload.fotoRemisionDataUrl, "saved-new-remission");
    }
  });
  test(`${kind}: verified repeats keep one audit and preserve newly saved evidence`, async () => {
    const f = recorderFixture(kind);
    assert.equal(await f.invoke(process), true); assert.equal(await f.invoke(process), true);
    assert.equal(f.state.inserts, 1);
    assert.equal(f.state.payload.fotoRemisionDataUrl, "saved-new-remission");
    assert.equal(f.state.payload.fotoEntregaDataUrl, "saved-delivery");
  });
}
