import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";
const jiti = createJiti(import.meta.url, { alias: { "@/lib/datacredito/firmaseguro-identity": fileURLToPath(new URL("../lib/datacredito/firmaseguro-identity.ts", import.meta.url)) } });
const pure = await jiti.import("../lib/datacredito/firmaseguro-identity.ts");
const { readFirmaSeguroContractIdentity } = await jiti.import("../lib/firmaseguro-contract-identity.ts");
const { extractVeriffIdentityData, extractVeriffIdentityDataEvidence, extractVeriffIdentityDocumentEvidence, extractVeriffSessionUrl } = await jiti.import("../lib/veriff.ts");
const { compareStrictIdentityDocuments, compareDataCreditoVeriffIdentityEvidence } = await jiti.import("../lib/veriff-identity.ts");
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
test("identity evidence distinguishes an explicit full name from a derived partial name", () => {
  const payload = { verification: { person: { firstName: "María del Mar", idNumber: input.documentNumber } } };
  assert.equal(extractVeriffIdentityData(payload).fullName, "María del Mar");
  assert.equal(extractVeriffIdentityData(payload, { inferFullName: false }).fullName, null);
  payload.verification.person.fullName = "Otro Nombre";
  assert.equal(extractVeriffIdentityData(payload, { inferFullName: false }).fullName, "Otro Nombre");
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

test("the same CC binds real Veriff signing components independently of DataCrédito's name", () => {
  const fullName = "MARCOS ANDRES PATIÑO GOMEZ";
  for (const [firstName, lastName] of [["MARCOS ANDRÉS", "PATIÑO GÓMEZ"], ["MARCOS ANDRE\u0301S", "PATIÑO GÓMEZ"], ["MARCOS ANDRES", "PATINO GOMEZ"], ["LUISA MARIA", "ROJAS PEREZ"]]) {
    const result = pure.resolveFirmaSeguroFullNameIdentity({ ...input, fullName, firstName, lastName });
    assert.equal(result.canonicalFullName, fullName);assert.equal(result.firstName, firstName.normalize("NFC"));assert.equal(result.firstLastName, lastName);
    assert.deepEqual(pure.readFirmaSeguroFullNameIdentity(result, { fullName, documentNumber: input.documentNumber }), result);
  }
  assert.throws(() => pure.resolveFirmaSeguroFullNameIdentity({ ...input, fullName, firstName: "MARCOS ANDRES", lastName: "PATINO GOMEZ", veriffDocumentNumber: "987654321" }), error => error.reason === "identity-binding");
  const metadata = pure.resolveFirmaSeguroFullNameIdentity({ ...input, fullName, firstName: "LUISA MARIA", lastName: "ROJAS PEREZ",
    additionalIdentities: [{ firstName: "OTRO NOMBRE", lastName: "OTRO APELLIDO", fullName, documentNumber: input.documentNumber }] });
  assert.equal(metadata.firstName, "LUISA MARIA");assert.equal(metadata.firstLastName, "ROJAS PEREZ");assert.equal(metadata.canonicalFullName, fullName);
});

test("missing or malformed components and mismatched documents fail closed without inventing surnames", () => {
  for (const change of [
    { firstName: null }, { lastName: "" }, { lastName: "12345" },
    { firstName: 1234 },
    { veriffDocumentNumber: "123456780" }, { veriffDocumentNumber: "CC123456789" },
    { validationId: 0 }, { firstName: "x".repeat(101) },
    { additionalIdentities: [{ documentNumber: "987654321" }] },
  ]) assert.throws(() => pure.resolveFirmaSeguroFullNameIdentity({ ...input, ...change }), /FirmaSeguro requiere/);
  const result = pure.resolveFirmaSeguroFullNameIdentity(input);
  for (const metadata of [null, { ...result, source: "DATACREDITO" }, { ...result, secondLastName: "Inventado" }, { ...result, canonicalFullName: "Otro" }]) {
    assert.throws(() => pure.readFirmaSeguroFullNameIdentity(metadata, { fullName: canonical, documentNumber: input.documentNumber }));
  }
});

function fixture(overrides = {}) {
  const person = { firstName: "María del Mar", lastName: "De la Peña Muñoz", fullName: canonical, idNumber: input.documentNumber };
  const validation = { id: 42, draftId: 530, creditoId: null, clienteDocumento: input.documentNumber,
    status: "APPROVED", decisionPayload: { verification: { person, document: { number: input.documentNumber, type: "ID_CARD", country: "CO" } } }, webhookPayload: null, ...overrides.validation };
  const module = { exports: {} }; const reads = [];
  const source = readFileSync(new URL("../lib/datacredito/firmaseguro-identity-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const modules = {
    "server-only": {}, "@/lib/prisma": { default: { $queryRawUnsafe: async (...args) => { reads.push(args); return [{ id: overrides.latestId ?? 42 }]; } } },
    "@/lib/veriff": { extractVeriffIdentityDataEvidence }, "@/lib/veriff-identity": { compareStrictIdentityDocuments },
    "./firmaseguro-identity": pure,
    "./firmaseguro-identity-review": { getStoredFirmaSeguroIdentityReview: async args => { reads.push({ reviewBinding: args });return overrides.review || null; }, FirmaSeguroIdentityReviewError: class extends Error {} },
    "@/lib/veriff-storage": { getVeriffValidationById: async id => { reads.push(id); return validation; },
      isVeriffApproved: row => row.status === "APPROVED" && overrides.trusted !== false,
      serializeVeriffValidation: row => {
        const compared = compareDataCreditoVeriffIdentityEvidence([extractVeriffIdentityDocumentEvidence(row.decisionPayload), extractVeriffIdentityDocumentEvidence(row.webhookPayload)], row.clienteDocumento);
        return { identityDocumentStatus: overrides.documentStatus || compared.status, identityDocumentNumber: compared.ok ? compared.documentNumber : null };
      } },
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

test("the bridge and FirmaSeguro payload use real Veriff names while keeping a different DataCrédito name separate", async () => {
  const fullName = "MARCOS ANDRES PATIÑO GOMEZ";
  const person = { firstName: "LUISA MARIA", lastName: "ROJAS PEREZ", idNumber: input.documentNumber };
  const decisionPayload = { verification: { person, document: { number: "PHYSICAL-SERIAL", type: "ID_CARD", country: "CO" } } };
  const binding = { fullName, documentNumber: input.documentNumber, draftId: 530, validationId: 42 };
  const f = fixture({ validation: { decisionPayload } });
  const result = await f.getFirmaSeguroFullNameIdentityForDraft(binding);
  assert.equal(result.canonicalFullName, fullName);assert.equal(result.firstName, person.firstName);assert.equal(result.firstLastName, person.lastName);
  const signing = adapter()({ clienteNombre: fullName, clienteDocumento: input.documentNumber,
    contratoSnapshot: { dataCreditoIdentity: { effective: { nameMode: "FULL_NAME_ONLY", fullName } }, firmaSeguroIdentity: result } });
  assert.equal(signing.firstName, person.firstName);assert.equal(signing.firstLastName, person.lastName);
  for (const overrides of [{ latestId: 43 }, { trusted: false }, { validation: { status: "DECLINED" } },
    { validation: { decisionPayload: { verification: { ...decisionPayload.verification, person: { ...person, idNumber: "987654321" } } } } },
    { validation: { decisionPayload: { verification: { ...decisionPayload.verification, person: { ...person, lastName: null } } } } }]) {
    const blocked = fixture({ ...overrides, validation: { decisionPayload, ...overrides.validation } });
    await assert.rejects(blocked.getFirmaSeguroFullNameIdentityForDraft(binding));
  }
});

test("a document-only or compatible partial payload cannot hide the other payload's complete Veriff name", async () => {
  const payload = person => ({ verification: { person: { idNumber: input.documentNumber, ...person }, document: { number: input.documentNumber, type: "ID_CARD", country: "CO" } } });
  const complete = payload({ firstName: "María del Mar", lastName: "De la Peña Muñoz" });
  for (const partial of [{}, { fullName: canonical }, { firstName: "María del Mar" }, { lastName: "De la Peña Muñoz" }]) {
    for (const [decisionPayload, webhookPayload] of [[payload(partial), complete], [complete, payload(partial)]]) {
      const f = fixture({ validation: { decisionPayload, webhookPayload } });
      const result = await f.getFirmaSeguroFullNameIdentityForDraft({ fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 });
      assert.equal(result.source, "VERIFF");assert.equal(result.firstName, "María del Mar");assert.equal(result.firstLastName, "De la Peña Muñoz");
      assert.equal(f.reads.length, 2, "valid provider evidence does not require manual review or a provider call");
    }
  }
});

test("signing selects one complete response without merging names or comparing their content with DataCrédito", async () => {
  const payload = person => ({ verification: { person: { idNumber: input.documentNumber, ...person }, document: { number: input.documentNumber, type: "ID_CARD", country: "CO" } } });
  const complete = payload({ firstName: "María del Mar", lastName: "De la Peña Muñoz" });
  const incomplete = fixture({ validation: { decisionPayload: payload({ firstName: "María del Mar" }), webhookPayload: payload({ lastName: "De la Peña Muñoz" }) } });
  await assert.rejects(incomplete.getFirmaSeguroFullNameIdentityForDraft({ fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 }));
  for (const [decisionPayload, webhookPayload] of [
    [payload({ firstName: "Otro" }), complete],
    [payload({ lastName: "Otro" }), complete],
    [payload({ firstName: "María del Mar", fullName: "Otro Nombre" }), complete],
    [complete, payload({ fullName: "Otro Nombre" })],
  ]) {
    const f = fixture({ validation: { decisionPayload, webhookPayload } });
    const result = await f.getFirmaSeguroFullNameIdentityForDraft({ fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 });
    assert.equal(result.firstName, "María del Mar");assert.equal(result.firstLastName, "De la Peña Muñoz");
  }
});

test("persisted decision/person wrappers supply a complete pair and keep decision-person-webhook precedence", async () => {
  const decisionPayload = { verification: { person: { idNumber: input.documentNumber }, document: { number: input.documentNumber, type: "ID_CARD", country: "CO" } } };
  const personPayload = { data: { person: { firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: input.documentNumber } } };
  const wrapper = { decisionPayload, personPayload };
  const binding = { fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 };
  const f = fixture({ validation: { decisionPayload: wrapper } });
  const result = await f.getFirmaSeguroFullNameIdentityForDraft(binding);
  assert.equal(result.firstName, "María del Mar");assert.equal(result.firstLastName, "De la Peña Muñoz");assert.equal(f.reads.length, 2);
  for (const person of [
    { firstName: "María del Mar", idNumber: input.documentNumber },
    { firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: "987654321" },
  ]) {
    const broken = fixture({ validation: { decisionPayload: { decisionPayload, personPayload: { person } } } });
    await assert.rejects(broken.getFirmaSeguroFullNameIdentityForDraft(binding));
  }
  const separate = fixture({ validation: { decisionPayload: {
    decisionPayload: { ...decisionPayload, verification: { ...decisionPayload.verification, person: { firstName: "María del Mar", idNumber: input.documentNumber } } },
    personPayload: { person: { lastName: "De la Peña Muñoz", idNumber: input.documentNumber } },
  } } });
  await assert.rejects(separate.getFirmaSeguroFullNameIdentityForDraft(binding));
  const conflictingWebhook = fixture({ validation: { decisionPayload: wrapper, webhookPayload: { verification: { person: { firstName: "Otro", idNumber: input.documentNumber } } } } });
  assert.equal((await conflictingWebhook.getFirmaSeguroFullNameIdentityForDraft(binding)).firstName, "María del Mar");
  const authoritative = { firstName: "LUISA MARIA", lastName: "ROJAS PEREZ", idNumber: input.documentNumber };
  const reorderedWrapper = fixture({ validation: { decisionPayload: {
    personPayload, decisionPayload: { verification: { person: authoritative, document: decisionPayload.verification.document } },
  }, webhookPayload: { verification: { person: { firstName: "OTRO NOMBRE", lastName: "OTRO APELLIDO", idNumber: input.documentNumber } } } } });
  const chosen = await reorderedWrapper.getFirmaSeguroFullNameIdentityForDraft(binding);
  assert.equal(chosen.firstName, authoritative.firstName);assert.equal(chosen.firstLastName, authoritative.lastName);assert.equal(chosen.canonicalFullName, canonical);
  const ignored = extractVeriffIdentityDataEvidence({ request: personPayload, createPayload: personPayload });
  assert.equal(ignored.length, 0, "request/create fields never become signing evidence");
});

test("flat person responses and known arrays cannot conceal a different CC or override the complete decision pair", async () => {
  const decisionPayload = { verification: { person: { idNumber: input.documentNumber }, document: { number: "PHYSICAL-SERIAL", type: "ID_CARD", country: "CO" } } };
  const complete = { firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: input.documentNumber };
  const binding = { fullName: canonical, documentNumber: input.documentNumber, draftId: 530, validationId: 42 };
  const personWithSerial = { person: complete, document: { number: "PHYSICAL-SERIAL", type: "ID_CARD", country: "CO" } };
  for (const personPayload of [complete, { data: complete }, { verification: complete }, { person: [complete] }, { persons: [complete] }, { personData: complete }, personWithSerial, { data: personWithSerial }]) {
    const f = fixture({ validation: { decisionPayload: { decisionPayload, personPayload } } });
    assert.equal((await f.getFirmaSeguroFullNameIdentityForDraft(binding)).source, "VERIFF");
  }
  for (const identity of [{ ...complete, idNumber: "987654321" }]) {
    for (const personPayload of [identity, { data: identity }, { verification: identity }, { person: [identity] }, { persons: [identity] }, { personData: identity }]) {
      const f = fixture({ validation: { decisionPayload: { decisionPayload: { verification: { ...decisionPayload.verification, person: complete } }, personPayload } } });
      await assert.rejects(f.getFirmaSeguroFullNameIdentityForDraft(binding));
    }
  }
  for (const personPayload of [{ persons: [{ ...complete, firstName: "Otra Persona" }] }, { personData: { ...complete, lastName: "Otro Apellido" } }]) {
    const f = fixture({ validation: { decisionPayload: { decisionPayload: { verification: { ...decisionPayload.verification, person: complete } }, personPayload } } });
    const result = await f.getFirmaSeguroFullNameIdentityForDraft(binding);
    assert.equal(result.firstName, complete.firstName);assert.equal(result.firstLastName, complete.lastName);
  }
  assert.throws(() => pure.resolveFirmaSeguroFullNameIdentityFromEvidence({ ...input, identities: [{ ...complete, documentNumber: "987654321" }] }), error => error.reason === "identity-binding");
});

test("the persisted serializer rejects a different CC inside flat provider wrappers without using the physical document serial", () => {
  const source = readFileSync(new URL("../lib/veriff-storage.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("veriff-storage.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "serializeVeriffValidation").getText(ast);
  const compiled = ts.transpileModule(declaration + "\nmodule.exports = serializeVeriffValidation;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, resolveVeriffRowStatus: () => "APPROVED", areVeriffDecisionsTrusted: () => true,
    extractVeriffIdentityData, extractVeriffIdentityDocumentEvidence, extractVeriffSessionUrl, compareDataCreditoVeriffIdentityEvidence });
  for (const [idNumber, expected] of [[input.documentNumber, "match"], ["987654321", "conflict"]]) {
    const decisionPayload = { verification: { person: { idNumber: input.documentNumber }, document: { number: "PHYSICAL-SERIAL", type: "ID_CARD", country: "CO" } } };
    const person = { firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber };
    for (const personPayload of [person, { data: person }, { verification: person }]) {
      const result = loaded.exports({ clienteDocumento: input.documentNumber, decisionPayload: { decisionPayload, personPayload }, webhookPayload: null });
      assert.equal(result.identityDocumentStatus, expected);assert.equal(result.identityDocumentNumber, expected === "match" ? input.documentNumber : null);
    }
  }
});

test("the bridge rejects stale, foreign, untrusted or conflicting decision/webhook identity before any dispatch", async () => {
  for (const change of [
    { latestId: 43 }, { trusted: false }, { documentStatus: "conflict" },
    { validation: { draftId: 531 } }, { validation: { creditoId: 99 } },
    { validation: { status: "DECLINED" } }, { validation: { clienteDocumento: "123456780" } },
    { validation: { decisionPayload: { verification: { person: { fullName: canonical, idNumber: input.documentNumber } } } } },
    { validation: { webhookPayload: { verification: { person: { firstName: "Otro", lastName: "Nombre", idNumber: "987654321" } } } } },
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
  runInNewContext(output, { module: loaded, exports: loaded.exports, readFirmaSeguroFullNameIdentity: pure.readFirmaSeguroFullNameIdentity, readFirmaSeguroContractIdentity,
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

test("new structured DataCrédito contracts send the complete real Veriff pair without changing the DataCrédito snapshot", () => {
  const metadata = pure.resolveFirmaSeguroFullNameIdentity({ ...input, firstName: "LUISA MARIA", lastName: "ROJAS PEREZ" });
  const snapshot = { firmaSeguroContractNameVersion: 1, firmaSeguroIdentity: metadata,
    dataCreditoIdentity: { effective: { fullName: canonical, names: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz" } } };
  const credit = { clienteNombre: canonical, clienteDocumento: input.documentNumber, contratoSnapshot: snapshot };
  const before = JSON.stringify(credit);
  const result = adapter()(credit);
  assert.equal(result.firstName, "LUISA MARIA");assert.equal(result.firstLastName, "ROJAS PEREZ");assert.equal(result.document, input.documentNumber);
  assert.equal(result.canonicalFullName, canonical);assert.equal(JSON.stringify(credit), before);
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
