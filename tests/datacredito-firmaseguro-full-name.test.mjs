import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";
const jiti = createJiti(import.meta.url);
const pure = await jiti.import("../lib/datacredito/firmaseguro-identity.ts");
const { extractVeriffIdentityData } = await jiti.import("../lib/veriff.ts");
const { compareStrictIdentityDocuments } = await jiti.import("../lib/veriff-identity.ts");
const canonical = "María del Mar  De la Peña Muñoz";
const input = { fullName: canonical, documentNumber: "123456789", validationId: 42,
  veriffDocumentNumber: "123.456.789", firstName: "MARÍA DEL MAR", lastName: "DE LA PEÑA MUÑOZ" };

test("Veriff preserves the document firstName instead of stripping additional given names", () => {
  const result = extractVeriffIdentityData({ verification: { person: {
    firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: input.documentNumber,
    nameComponents: { firstNameOnly: "María", middleName: "del Mar" },
  } } });
  assert.equal(result.firstName, "María del Mar");
  assert.equal(result.fullName, "María del Mar De la Peña Muñoz");
  assert.equal(pure.resolveFirmaSeguroFullNameIdentity({ ...input, firstName: result.firstName, lastName: result.lastName }).firstName, "María del Mar");
});
test("FirmaSeguro gets complete Veriff components without splitting the canonical DataCrédito name", () => {
  const result = pure.resolveFirmaSeguroFullNameIdentity(input);
  assert.equal(result.canonicalFullName, canonical);
  assert.equal(result.source, "VERIFF"); assert.equal(result.validationId, 42);
  assert.equal(result.firstName, "MARÍA DEL MAR"); assert.equal(result.firstLastName, "DE LA PEÑA MUÑOZ");
  assert.equal(result.secondName, null); assert.equal(result.secondLastName, null);
  const nfd = pure.resolveFirmaSeguroFullNameIdentity({ ...input, firstName: "Mari\u0301a del Mar", lastName: "De la Pen\u0303a Mun\u0303oz" });
  assert.equal(nfd.firstName, "María del Mar"); assert.equal(nfd.canonicalFullName, canonical);
  assert.deepEqual(pure.readFirmaSeguroFullNameIdentity(result, { fullName: canonical, documentNumber: "123456789" }), result);
});

test("missing, conflicting or incompatible Veriff components fail closed instead of inventing surnames", () => {
  for (const change of [
    { firstName: null }, { lastName: "" }, { lastName: "DE LA PENA MUÑOZ" },
    { firstName: "MARIA DEL MAR" }, { firstName: "María" },
    { veriffDocumentNumber: "123456780" }, { veriffDocumentNumber: "CC123456789" },
    { validationId: 0 }, { firstName: "x".repeat(101) },
    { additionalIdentities: [{ firstName: "Otro" }] },
    { additionalIdentities: [{ fullName: "María del Mar De la Pena Muñoz" }] },
    { additionalIdentities: [{ lastName: "Muñoz" }] },
  ]) assert.throws(() => pure.resolveFirmaSeguroFullNameIdentity({ ...input, ...change }), /FirmaSeguro requiere/);
  const result = pure.resolveFirmaSeguroFullNameIdentity(input);
  for (const metadata of [null, { ...result, source: "DATACREDITO" }, { ...result, secondLastName: "Inventado" }, { ...result, canonicalFullName: "Otro" }]) {
    assert.throws(() => pure.readFirmaSeguroFullNameIdentity(metadata, { fullName: canonical, documentNumber: input.documentNumber }));
  }
});

function fixture(overrides = {}) {
  const person = { firstName: "María del Mar", lastName: "De la Peña Muñoz", fullName: canonical, idNumber: input.documentNumber };
  const validation = { id: 42, draftId: 530, creditoId: null, clienteDocumento: input.documentNumber,
    status: "APPROVED", decisionPayload: { verification: { person } }, webhookPayload: null, ...overrides.validation };
  const module = { exports: {} }; const reads = [];
  const source = readFileSync(new URL("../lib/datacredito/firmaseguro-identity-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const modules = {
    "server-only": {}, "@/lib/prisma": { default: { $queryRawUnsafe: async (...args) => { reads.push(args); return [{ id: overrides.latestId ?? 42 }]; } } },
    "@/lib/veriff": { extractVeriffIdentityData }, "@/lib/veriff-identity": { compareStrictIdentityDocuments },
    "./firmaseguro-identity": pure,
    "./firmaseguro-identity-review": { getStoredFirmaSeguroIdentityReview: async args => { reads.push({ reviewBinding: args });return overrides.review || null; }, FirmaSeguroIdentityReviewError: class extends Error {} },
    "@/lib/veriff-storage": { getVeriffValidationById: async id => { reads.push(id); return validation; },
      isVeriffApproved: row => row.status === "APPROVED" && overrides.trusted !== false,
      serializeVeriffValidation: () => ({ identityDocumentStatus: overrides.documentStatus || "match", identityDocumentNumber: input.documentNumber }) },
  };
  runInNewContext(compiled, { module, exports: module.exports, require: name => { assert.ok(modules[name], name); return modules[name]; } });
  return { ...module.exports, validation, reads };
}

test("the bridge reuses the latest trusted approval for the same draft and document using reads only", async () => {
  const f = fixture();
  const result = await f.getFirmaSeguroFullNameIdentityForDraft({ fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 });
  assert.equal(result.firstName, "María del Mar"); assert.equal(result.firstLastName, "De la Peña Muñoz");
  assert.equal(f.reads.length, 2); assert.equal(f.reads[0], 42); assert.match(f.reads[1][0], /^SELECT /);
});

test("the bridge rejects stale, foreign, untrusted or conflicting decision/webhook identity before any dispatch", async () => {
  for (const change of [
    { latestId: 43 }, { trusted: false }, { documentStatus: "conflict" },
    { validation: { draftId: 531 } }, { validation: { creditoId: 99 } },
    { validation: { status: "DECLINED" } }, { validation: { clienteDocumento: "123456780" } },
    { validation: { decisionPayload: { verification: { person: { fullName: canonical, idNumber: input.documentNumber } } } } },
    { validation: { webhookPayload: { verification: { person: { firstName: "Otro", lastName: "Nombre", idNumber: input.documentNumber } } } } },
  ]) {
    const f = fixture(change);
    await assert.rejects(f.getFirmaSeguroFullNameIdentityForDraft({ fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 }), /FirmaSeguro requiere/);
  }
});

function adapter() {
  const source = readFileSync(new URL("../lib/firmaseguro-credit.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("adapter.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["cleanText", "cleanName", "ensureProviderName", "normalizeEmail", "normalizePhone", "splitClientName"];
  const declarations = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join("\n");
  const output = ts.transpileModule(declarations + "\nmodule.exports = splitClientName;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  class FirmaSeguroApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  runInNewContext(output, { module: loaded, exports: loaded.exports, readFirmaSeguroFullNameIdentity: pure.readFirmaSeguroFullNameIdentity,
    dataCreditoIdentityToFirmaSeguroNames: () => assert.fail("fullNameOnly must not fall through to structured or historical splitting"), FirmaSeguroApiError });
  return loaded.exports;
}

test("both adapter paths preserve the canonical name and never invoke historical splitting for fullNameOnly", () => {
  const resolve = adapter(); const metadata = pure.resolveFirmaSeguroFullNameIdentity(input);
  const credit = { clienteNombre: canonical, clienteDocumento: input.documentNumber, clienteCorreo: "cliente@example.com", clienteTelefono: "3001234567",
    contratoSnapshot: { dataCreditoIdentity: { effective: { nameMode: "FULL_NAME_ONLY", fullName: canonical } }, firmaSeguroIdentity: metadata } };
  const result = resolve(credit);
  assert.equal(result.firstName, input.firstName); assert.equal(result.firstLastName, input.lastName);
  assert.equal(result.document, input.documentNumber);
  assert.throws(() => resolve({ ...credit, contratoSnapshot: { dataCreditoIdentity: credit.contratoSnapshot.dataCreditoIdentity } }), error => error.status === 409);
  assert.throws(() => resolve({ ...credit, clienteNombre: "Otro" }), error => error.status === 409);
});

test("only server-built identity metadata is retained on the signing record", () => {
  const route = readFileSync(new URL("../app/api/creditos/borradores/[id]/firma-seguro/route.ts", import.meta.url), "utf8");
  const guard = route.indexOf("delete firmaSeguroDraftPayload.firmaSeguroIdentity;");
  assert.ok(guard > 0); assert.ok(route.indexOf("payloadObject(credit.contratoSnapshot).firmaSeguroIdentity", guard) > guard);
  assert.ok(route.indexOf("await reserveDraftDispatch", guard) > guard);
});


test("CC-only aprobado usa exclusivamente metadata de revisión cargada por el servidor", async () => {
  const review = pure.resolveReviewedFirmaSeguroFullNameIdentity({ fullName: canonical, documentNumber: input.documentNumber,
    reviewedDocumentNumber: input.documentNumber, reviewId: "12345678-1234-4234-8234-123456789012", validationId: 42,
    firstNames: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz" });
  const f = fixture({ review, validation: { decisionPayload: { verification: { person: { idNumber: input.documentNumber } } } } });
  const binding = { fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 };
  const result = await f.getFirmaSeguroFullNameIdentityForDraft(binding);
  assert.equal(result.source, "AUTHORIZED_REVIEW");assert.equal(result.reviewId, review.reviewId);
  assert.deepEqual(f.reads[2].reviewBinding, binding);assert.equal(result.firstLastName, "De la Peña");assert.equal(result.secondLastName, "Muñoz");
  const resolve = adapter();const person = resolve({ clienteNombre: canonical, clienteDocumento: input.documentNumber,
    contratoSnapshot: { dataCreditoIdentity: { effective: { nameMode: "FULL_NAME_ONLY", fullName: canonical } }, firmaSeguroIdentity: result } });
  assert.equal(person.firstName, "María del Mar");assert.equal(person.firstLastName, "De la Peña");assert.equal(person.secondLastName, "Muñoz");
});
