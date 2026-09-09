import assert from "node:assert/strict";
import test from "node:test";
import { evidence, history, photos, actor, evidenceDatabase, correctionInput, loadApprovalModule, service, sanitizer } from "./credit-approval-evidence-test-loader.mjs";

test("la corrección exige clave permitida, imagen válida y revisión exacta", async () => {
  const input = { key: "foto-entrega", dataUrl: photos[0], revision: 1, reviewHash: "a".repeat(64) };
  assert.equal((await evidence.prepareEvidenceCorrection(input)).dataUrl, photos[0]);
  for (const bad of [null, { ...input, key: "contratoSnapshot" }, { ...input, actor: 99 }, { ...input, revision: 0 },
    { ...input, reviewHash: "old" }, { ...input, dataUrl: photos[0].replace("image/png", "image/jpeg") },
    { ...input, dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }, { ...input, dataUrl: "x".repeat(2_500_001) }]) {
    await assert.rejects(evidence.prepareEvidenceCorrection(bad));
  }
});

test("cada fotografía se cambia sola, conserva bytes anteriores y exige nuevo OK", async (t) => {
  for (const { key, field } of service.APPROVAL_EVIDENCE) await t.test(key, async () => {
    const { db, state } = evidenceDatabase();
    const before = structuredClone(state.credit);
    const originalPdf = state.document.signedDocumentBase64;
    const input = await correctionInput(db, photos[0], key);
    state.queries.length = 0;
    const result = await evidence.replaceApprovalEvidence(db, 81, input, actor);
    assert.equal(result.unchanged, false);
    assert.equal(result.item.review.status, "PENDING");
    assert.equal(result.item.review.revision, 3);
    assert.notEqual(result.item.review.reviewHash, input.reviewHash);
    assert.equal(state.credit[field], photos[0]);
    for (const other of service.APPROVAL_EVIDENCE.filter((item) => item.key !== key)) assert.equal(state.credit[other.field], before[other.field]);
    assert.equal(state.document.signedDocumentBase64, originalPdf);
    assert.deepEqual(state.credit.contratoSnapshot.financiero, before.contratoSnapshot.financiero);
    assert.equal(state.archives.length, 1);
    assert.equal(state.archives[0][3], before[field]);
    assert.equal(state.archives[0][4], history.evidenceSha256(before[field]));
    assert.equal(state.archives[0][5], history.evidenceSha256(photos[0]));
    assert.equal(state.archives[0][6], actor.id);
    assert.equal(state.archives[0][7], actor.nombre);
    assert.equal(state.archives[0][9], 2);
    assert.match(state.queries[0].sql, /FROM "Credito".*FOR UPDATE/);
    assert.match(state.queries[1].sql, /FROM "CreditApprovalReview".*FOR UPDATE/);
  });
});

test("la selección obsoleta no reemplaza fotos ni crea historial", async () => {
  const { db, state } = evidenceDatabase();
  const input = await correctionInput(db);
  state.credit.fotoRemisionDataUrl = photos[2];
  await assert.rejects(evidence.replaceApprovalEvidence(db, 81, input, actor), { code: "REVIEW_CHANGED", status: 409 });
  assert.equal(state.archives.length, 0);
});

test("históricos, pagados y anulados no admiten corrección aunque falten fotos", async (t) => {
  for (const changes of [{ required: false }, { paid: true }, { estado: "ANULADO" }, { estado: "CANCELADA" }]) await t.test(JSON.stringify(changes), async () => {
    const { db, state } = evidenceDatabase();
    Object.assign(state.credit, changes, { fotoEntregaDataUrl: null });
    const input = await correctionInput(db);
    await assert.rejects(evidence.replaceApprovalEvidence(db, 81, input, actor), { code: "CORRECTION_NOT_ALLOWED", status: 409 });
    assert.equal(state.archives.length, 0);
  });
});

test("reponer una foto ausente no depende de canApprove ni vuelve a consultar proveedores", async () => {
  const { db, state } = evidenceDatabase({ assessment: null, document: null });
  state.credit.fotoEntregaDataUrl = null;
  const input = await correctionInput(db);
  const result = await evidence.replaceApprovalEvidence(db, 81, input, actor);
  assert.equal(result.item.canApprove, false);
  assert.equal(state.archives[0][3], null);
  assert.equal(state.archives[0][4], null);
});

test("la misma foto es idempotente y fotos de identidad repetidas se rechazan", async () => {
  const { db, state } = evidenceDatabase();
  state.credit.contratoCedulaFrenteDataUrl = photos[0];
  state.credit.contratoCedulaRespaldoDataUrl = photos[1];
  const unchanged = await correctionInput(db, photos[0], "cedula-frente");
  assert.equal((await evidence.replaceApprovalEvidence(db, 81, unchanged, actor)).unchanged, true);
  assert.equal(state.archives.length, 0);
  const duplicated = await correctionInput(db, photos[1], "cedula-frente");
  await assert.rejects(evidence.replaceApprovalEvidence(db, 81, duplicated, actor), { code: "DUPLICATE_IDENTITY_EVIDENCE" });
  assert.equal(state.archives.length, 0);
});

function adminHarness(blocked) {
  const trace = [];
  const credit = { id: 81, folio: "TEST-81", estado: "ACTIVO", contratoSnapshot: {},
    ...Object.fromEntries(service.APPROVAL_EVIDENCE.map(({ field }, i) => [field, photos[i]])) };
  const tx = {
    credito: {
      async findFirst(options) { trace.push(options.select.contratoSnapshot ? "snapshot" : "lookup"); return structuredClone(credit); },
      async update(options) { trace.push("update"); Object.assign(credit, options.data); return { id: 81, folio: "TEST-81", updatedAt: new Date() }; },
    },
    async $queryRawUnsafe(sql) { trace.push(sql.includes('FROM "Credito"') ? "lock-credit" : "lock-review"); return []; },
    async $executeRawUnsafe(_sql, ...params) { trace.push("archive"); assert.equal(params[3], photos[3]); return 1; },
  };
  const route = loadApprovalModule("app/api/creditos/[id]/evidencias/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/auth": { getSessionUser: async () => ({ ...actor, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", usuario: "admin-test" }) },
    "@/lib/prisma": { default: { $transaction: (callback) => callback(tx) } },
    "@/lib/roles": { isAdminRole: (role) => role === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: (code) => code === "FINSERPAY" },
    "@/lib/credit-route-lookup": { parseCreditRouteLookup: (id) => ({ id: Number(id) }), buildCreditLookupWhere: (lookup) => lookup },
    "@/lib/iphone-delivery-evidence": sanitizer,
    "@/lib/credit-approval-evidence-history": history,
    "@/lib/credit-approval-novelty-state": { markNoveltyPhotoCorrected: async () => false },
    "@/lib/credit-approval-reissue-state": { getCreditApprovalReissueState: async () => ({ blocked, operation: blocked ? { message: "Firma en curso" } : null }) },
  });
  return { route, trace };
}

test("la corrección admin bloquea firma en curso antes de leer o escribir fotografías", async () => {
  const { route, trace } = adminHarness(true);
  const result = await route.PATCH(new Request("https://finser.test/api/creditos/81/evidencias", { method: "PATCH", body: JSON.stringify({ key: "foto-entrega", dataUrl: photos[5] }) }), { params: Promise.resolve({ id: "81" }) });
  assert.equal(result.status, 409);
  assert.deepEqual(trace, ["lookup", "lock-credit", "lock-review"]);
});

test("la corrección admin archiva antes de actualizar y lee el snapshot después del lock", async () => {
  const { route, trace } = adminHarness(false);
  const result = await route.PATCH(new Request("https://finser.test/api/creditos/81/evidencias", { method: "PATCH", body: JSON.stringify({ key: "foto-entrega", dataUrl: photos[5] }) }), { params: Promise.resolve({ id: "81" }) });
  assert.equal(result.status, 200);
  assert.deepEqual(trace, ["lookup", "lock-credit", "lock-review", "snapshot", "archive", "update"]);
});
