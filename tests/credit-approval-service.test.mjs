import assert from "node:assert/strict";
import test from "node:test";
import { service, approvalFixture, approvalDatabase, plain, pdf, png } from "./credit-approval-test-loader.mjs";

const details = ({ credit, review, assessment, document }) => service.buildCreditApprovalDetail(credit, review, assessment, document);
const actor = { id: 7, nombre: "Analista de prueba" };

test("el expediente expone cinco fotos, documento y valores financieros persistidos", () => {
  const fixture = approvalFixture();
  const item = details(fixture);
  assert.equal(item.canApprove, true);
  assert.equal(item.review.status, "PENDING");
  assert.equal(item.review.revision, 1);
  assert.match(item.review.reviewHash, /^[a-f0-9]{64}$/);
  assert.equal(item.evidence.length, 5);
  assert.ok(item.evidence.every((evidence) => evidence.available));
  assert.equal(item.document.available, true);
  assert.equal(item.score, 750);
  assert.equal(item.cuotaInicial, 200000);
  assert.equal(item.initialPaymentPercentage, 15, "Conserva porcentaje de oferta distinto de la inicial aplicada");
  assert.equal(item.creditoAutorizado, 800000);
  assert.equal(item.approvedLimit, 900000, "El cupo contractual prevalece sobre la oferta");
});

test("score -1 conserva Sin información y no se confunde con una evaluación ausente", () => {
  const fixture = approvalFixture();
  fixture.assessment.score = -1;
  const item = details(fixture);
  assert.equal(item.score, null);
  assert.equal(item.scoreLabel, "Sin información");
  assert.equal(item.canApprove, true);
  fixture.assessment = null;
  const absent = details(fixture);
  assert.equal(absent.scoreLabel, "No disponible");
  assert.equal(absent.canApprove, false);
});

test("la huella detecta cambios de cada fotografía, PDF y datos revisados", async (t) => {
  const base = details(approvalFixture()).review.reviewHash;
  const changes = [
    ...service.APPROVAL_EVIDENCE.map(({ field }) => [field, (fixture) => { fixture.credit[field] = png.replace("image/png", "image/PNG"); }]),
    ["PDF firmado", (fixture) => { fixture.document.signedDocumentBase64 = Buffer.from("%PDF-1.7\nDocumento modificado\n%%EOF").toString("base64"); }],
    ["cuota inicial", (fixture) => { fixture.credit.cuotaInicial += 10000; }],
    ["principal", (fixture) => { fixture.credit.saldoBaseFinanciado -= 10000; }],
    ["valor de venta", (fixture) => { fixture.credit.valorEquipoTotal += 10000; }],
    ["cupo contractual", (fixture) => { fixture.credit.contratoSnapshot.financiero.dataCredito.resolvedMaxFinancedAmount += 10000; }],
    ["score", (fixture) => { fixture.assessment.score -= 1; }],
    ["oferta", (fixture) => { fixture.assessment.offer.initialPaymentPercentage += 1; }],
    ["identidad", (fixture) => { fixture.credit.clienteDocumento = "100000002"; }],
    ["equipo", (fixture) => { fixture.credit.equipoModelo = "Otro equipo"; }],
  ];
  for (const [name, change] of changes) await t.test(name, () => {
    const fixture = approvalFixture();
    change(fixture);
    assert.notEqual(details(fixture).review.reviewHash, base);
  });
});

test("reordenar las mismas propiedades JSON no cambia la huella", () => {
  const fixture = approvalFixture();
  const before = details(fixture).review.reviewHash;
  fixture.credit.contratoSnapshot.financiero.dataCredito = { resolvedMaxFinancedAmount: 900000, assessmentId: "assessment-81" };
  fixture.assessment.offer = { maxFinancedAmount: 950000, initialPaymentPercentage: 15 };
  assert.equal(details(fixture).review.reviewHash, before);
});

test("evidencia ausente, contenido incorrecto y PDF sin firma impiden aprobar", async (t) => {
  for (const { field, label } of service.APPROVAL_EVIDENCE) await t.test(label, () => {
    const fixture = approvalFixture();
    fixture.credit[field] = null;
    const item = details(fixture);
    assert.equal(item.canApprove, false);
    assert.ok(item.blockingReasons.some((reason) => reason.includes(label)));
  });
  for (const value of [null, "https://example.invalid/document.pdf", Buffer.from("HTML content").toString("base64")]) {
    const fixture = approvalFixture();
    fixture.document.signedDocumentBase64 = value;
    assert.equal(details(fixture).canApprove, false);
  }
  const unsigned = approvalFixture();
  unsigned.document.completedAt = null;
  unsigned.document.status = "PENDING";
  assert.equal(details(unsigned).document.available, false);
});

test("una evaluación pendiente o un score fuera de rango no habilita el OK", () => {
  for (const score of [null, -2, 951, 700.5, "invalid"]) {
    const fixture = approvalFixture();
    fixture.assessment.score = score;
    assert.equal(details(fixture).canApprove, false);
  }
  const pending = approvalFixture();
  pending.assessment.status = "PENDIENTE";
  assert.equal(details(pending).canApprove, false);
});

test("históricos, pagados, anulados y créditos sin plataforma o valores válidos no reciben un nuevo OK", async (t) => {
  const cases = [
    ["histórico", { required: false }, "NOT_REQUIRED"],
    ["pagado", { paid: true }, "PENDING"],
    ["anulado", { estado: "ANULADO" }, "PENDING"],
    ["sin plataforma", { contratoSnapshot: {}, equipoMarca: null }, "PENDING"],
    ["sin capital", { cuotaInicial: 1000000 }, "PENDING"],
  ];
  for (const [name, changes, status] of cases) await t.test(name, () => {
    const fixture = approvalFixture();
    Object.assign(fixture.credit, changes);
    const item = details(fixture);
    assert.equal(item.canApprove, false);
    assert.equal(item.review.status, status);
  });
});

test("valida estrictamente el identificador y el snapshot de aprobación", () => {
  assert.equal(service.approvalCreditId("81"), 81);
  for (const invalid of [81, "0", "-1", "1.2", "1 OR 1=1", "2147483648", null]) assert.throws(() => service.approvalCreditId(invalid), { code: "INVALID_CREDIT" });
  assert.equal(service.approvalDocumentNumber("1.000-000 01"), "100000001");
  for (const invalid of [null, "12", "abc", "1 OR 1=1"]) assert.throws(() => service.approvalDocumentNumber(invalid), { code: "INVALID_DOCUMENT" });
  const valid = { revision: 1, reviewHash: "a".repeat(64) };
  assert.deepEqual(plain(service.parseCreditApproval(valid)), valid);
  for (const invalid of [null, {}, { ...valid, revision: "1" }, { ...valid, revision: 0 }, { ...valid, reviewHash: "stale" }, { ...valid, creditoId: 82 }, { ...valid, status: "APPROVED" }]) assert.throws(() => service.parseCreditApproval(invalid), { code: "INVALID_REVIEW" });
});

test("requiere política activada antes de consultar expedientes", async () => {
  const { db, state } = approvalDatabase({ policy: false });
  await assert.rejects(service.getCreditApprovalDetail(db, 81), { code: "APPROVAL_UNAVAILABLE", status: 503 });
  assert.equal(state.queries.length, 1);
  assert.equal(state.writes.length, 0);
});

test("consulta la evaluación consumida vinculada al crédito y al snapshot, nunca otra consulta de la cédula", async () => {
  const { db, state } = approvalDatabase();
  const valid = await service.getCreditApprovalDetail(db, 81);
  assert.equal(valid.canApprove, true);
  const evaluationQuery = state.queries.find(({ sql }) => sql.includes('FROM "DataCreditoAssessment"'));
  assert.deepEqual(evaluationQuery.params, [81, "assessment-81"]);
  for (const changes of [{ creditId: 82 }, { id: "assessment-other" }, { consumedAt: null }, { retainedUntil: new Date("2000-01-01") }]) {
    const fixture = approvalFixture();
    Object.assign(fixture.assessment, changes);
    const wrong = approvalDatabase(fixture);
    assert.equal((await service.getCreditApprovalDetail(wrong.db, 81)).canApprove, false);
  }
});

test("un expediente modificado rechaza revisión obsoleta sin escribir aprobación ni evento", async () => {
  const { db, state } = approvalDatabase();
  const original = await service.getCreditApprovalDetail(db, 81);
  state.credit.cuotaInicial += 10000;
  await assert.rejects(service.approveCredit(db, 81, { revision: original.review.revision, reviewHash: original.review.reviewHash }, actor), { code: "REVIEW_CHANGED", status: 409 });
  assert.equal(state.writes.length, 0);
  assert.equal(state.events.length, 0);
});

test("el OK registra actor y revisión; repetirlo conserva el actor y no duplica eventos", async () => {
  const { db, state } = approvalDatabase();
  const before = await service.getCreditApprovalDetail(db, 81);
  const input = { revision: before.review.revision, reviewHash: before.review.reviewHash };
  const approved = await service.approveCredit(db, 81, input, actor);
  assert.equal(approved.unchanged, false);
  assert.equal(approved.item.review.status, "APPROVED");
  assert.equal(approved.item.review.approvedByName, actor.nombre);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0][1], 81);
  assert.equal(state.events[0][3], actor.id);
  assert.ok(state.queries.some(({ sql }) => sql.includes("FOR UPDATE OF credit")));
  const written = state.writes.length;
  const repeated = await service.approveCredit(db, 81, input, { id: 99, nombre: "Segundo analista" });
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.item.review.approvedByName, actor.nombre);
  assert.equal(state.events.length, 1);
  assert.equal(state.writes.length, written);
});

test("aprobar expediente incompleto no crea filas de revisión", async () => {
  const { db, state } = approvalDatabase({ document: null });
  const item = await service.getCreditApprovalDetail(db, 81);
  await assert.rejects(service.approveCredit(db, 81, { revision: item.review.revision, reviewHash: item.review.reviewHash }, actor), { code: "REVIEW_NOT_READY", status: 409 });
  assert.equal(state.writes.length, 0);
});

test("el parser de medios rechaza contenido activo y firmas MIME falsas", () => {
  assert.ok(service.approvalImage(png));
  assert.ok(service.approvalPdf(pdf));
  assert.equal(service.approvalImage(`data:image/png;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`), null);
  assert.equal(service.approvalImage(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`), null);
  assert.equal(service.approvalPdf(Buffer.from("<html>Not a PDF</html>").toString("base64")), null);
});

test("la retención de DataCrédito no revoca una revisión ya aprobada", () => {
  const fixture = approvalFixture();
  const before = details(fixture);
  fixture.review = { status: "APPROVED", revision: 2, approvedRevision: 2, approvedAt: new Date(), approvedByName: actor.nombre, reviewHash: before.review.reviewHash };
  fixture.assessment = null;
  const item = details(fixture);
  assert.equal(item.review.status, "APPROVED");
  assert.equal(item.review.approvedByName, actor.nombre);
  assert.equal(item.score, null);
  assert.equal(item.canApprove, false);
});

test("la invalidación de revisión exige un nuevo OK incluso si había aprobación previa", () => {
  const fixture = approvalFixture();
  fixture.review = { status: "PENDING", revision: 3, approvedRevision: 2, approvedAt: null, approvedByName: null, reviewHash: null };
  const item = details(fixture);
  assert.equal(item.review.status, "PENDING");
  assert.equal(item.review.revision, 3);
  assert.equal(item.canApprove, true);
});

test("la entrega del PDF valida firma y neutraliza nombres con inyección de cabeceras", async () => {
  const { db, state } = approvalDatabase();
  state.document.signedDocumentFileName = 'firmado"\r\nX-Injected:yes/path.pdf';
  const result = await service.getApprovalDocument(db, 81);
  assert.equal(result.bytes.subarray(0, 5).toString(), "%PDF-");
  assert.doesNotMatch(result.fileName, /[\r\n"\\/]/);
  state.document.status = "PENDING";
  state.document.completedAt = null;
  await assert.rejects(service.getApprovalDocument(db, 81), { code: "DOCUMENT_NOT_READY", status: 409 });
  assert.equal(state.writes.length, 0);
});

test("evidencia fuera de la lista permitida no llega a la base de datos", async () => {
  const { db, state } = approvalDatabase();
  await assert.rejects(service.getApprovalEvidence(db, 81, 'fotoEntregaDataUrl" FROM "Usuario"'), { code: "INVALID_EVIDENCE" });
  assert.equal(state.queries.length, 0);
});