import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { actor, createDocumentContinuityFixture, pdf, service } from "./credit-approval-call-document-fixture.mjs";

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
  [value, ...nodes(value.props?.children)];
const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
  value && typeof value === "object" ? text(value.props?.children) : "";
const uiSource = ts.transpileModule(readFileSync(new URL("../app/dashboard/aprobaciones/approval-call-recording.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function recordingPanel(detail) {
  const loaded = { exports: {} };
  runInNewContext(uiSource, {
    module: loaded, exports: loaded.exports, Intl, Date,
    require(name) {
      if (name === "react") return { useState: initial => [initial, () => {}], useRef: initial => ({ current: initial }), useEffect() {} };
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" };
      if (name === "lucide-react") return { Phone: () => null, Upload: () => null };
      if (name === "@/app/_components/finser-ui") return { Badge: "Badge", Button: "Button", Card: "Card" };
      if (name === "./approval-client") return {};
      throw new Error("Unexpected recording UI dependency: " + name);
    },
  });
  return loaded.exports.default({ detail, disabled: false, onUpdated: async () => {}, onBusyChange() {} });
}

function assertVisibleAudio(detail, recordingId) {
  assert.equal(detail.callRecording.recording?.id, recordingId);
  const tree = recordingPanel(detail);
  const audio = nodes(tree).find(node => node.type === "audio");
  assert.ok(audio, "el componente real mantiene el reproductor de la grabación");
  assert.equal(audio.props.src, `/api/aprobaciones/${detail.id}/grabaciones/${recordingId}`);
  assert.doesNotMatch(text(tree), /no hay una grabación|falta la grabación|borrad|eliminad/i);
}

test("el primer PDF recuperado conserva el audio inmutable y su cadena válida de revisión", async t => {
  const f = await createDocumentContinuityFixture(t);
  const mappings = async id => (await f.database.query(
    'SELECT * FROM "CreditApprovalCallDocumentContinuation" WHERE "creditoId"=$1 ORDER BY "targetRevision"', [id])).rows;
  const recordingCount = async id => (await f.database.query(
    'SELECT COUNT(*)::integer AS count FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1', [id])).rows[0].count;

  await t.test("recuperar el PDF del mismo proceso conserva audio, autor, fecha, huella y URL sin aprobar", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    const recordingId = uploaded.state.recording.id;
    const physical = await f.physical(recordingId);
    const before = await f.read(id);
    assert.equal(before.document.available, false);
    assertVisibleAudio(before, recordingId);
    const after = await f.recoverPdf(id, processUuid);
    assert.equal(after.document.available, true);
    assert.equal(after.review.status, "PENDING", "recuperar el documento no equivale a dar el OK");
    assert.ok(after.review.revision > before.review.revision);
    assert.notEqual(after.review.reviewHash, before.review.reviewHash);
    assertVisibleAudio(after, recordingId);
    assert.equal(after.callRecording.recording.revision, before.callRecording.recording.revision);
    assert.equal(after.callRecording.recording.reviewHash, before.callRecording.recording.reviewHash);
    assert.deepEqual(await f.physical(recordingId), physical, "la continuidad referencia el BLOB original sin reescribirlo");
    assert.equal(await recordingCount(id), 1);
    assert.equal(after.canApprove, true);
    const links = await mappings(id);
    assert.equal(links.length, 1);
    assert.equal(links[0].recordingId, recordingId);
    assert.equal(links[0].processUuid, processUuid);
    assert.equal(links[0].sourceRevision, before.review.revision);
    assert.equal(links[0].targetReviewHash, after.review.reviewHash);
    const originalAudio = await f.bytes(id, recordingId);
    assert.equal(originalAudio.bytes.length, physical.sizeBytes);
    assert.ok(originalAudio.bytes.equals(Buffer.from(physical.bytes)));
    const approved = await f.transaction(tx => service.approveCredit(tx, id, {
      revision: after.review.revision, reviewHash: after.review.reviewHash, recordingId,
    }, actor));
    assert.equal(approved.item.review.status, "APPROVED", "el OK posterior sigue requiriendo una acción explícita");
    assertVisibleAudio(approved.item, recordingId);
  });

  await t.test("la consulta repetida es idempotente y conserva un solo vínculo", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    const first = await f.recoverPdf(id, processUuid);
    const repeated = await f.recoverPdf(id, processUuid);
    assertVisibleAudio(repeated, uploaded.state.recording.id);
    assert.equal(repeated.review.revision, first.review.revision);
    assert.equal(repeated.review.reviewHash, first.review.reviewHash);
    assert.equal((await mappings(id)).length, 1);
  });

  await t.test("una instantánea RepeatableRead no crea continuidad y una lectura posterior ReadCommitted sí", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    await f.recoverPdf(id, processUuid, { read: false });
    assert.equal((await mappings(id)).length, 0);
    await f.transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const isolated = await service.getCreditApprovalDetail(tx, id, actor);
      assert.equal(isolated.callRecording.recording, null,
        "una instantánea antigua no debe decidir cuál fue la última grabación válida");
    });
    assert.equal((await mappings(id)).length, 0);
    const current = await f.read(id);
    assertVisibleAudio(current, uploaded.state.recording.id);
    assert.equal((await mappings(id)).length, 1);
  });

  await t.test("la ficha adquiere primero el bloqueo del crédito y después lee la revisión y su contexto", async () => {
    const { id, processUuid } = await f.createCredit();
    await f.upload(id);
    await f.recoverPdf(id, processUuid, { read: false });
    f.queries.length = 0;
    await f.read(id);
    const lock = f.queries.findIndex(({ sql }) => /FROM "Credito"(?: credit)?[\s\S]*FOR UPDATE/.test(sql));
    assert.ok(lock >= 0, "la lectura inicial obtiene Credit FOR UPDATE antes de resolver una continuidad");
    for (const [table, select] of [
      ["CreditApprovalReview", 'SELECT "status", "revision"'],
      ["DataCreditoAssessment", 'SELECT "id", "score", "offer", "status"'],
      ["FirmaSeguroProcess", 'SELECT "id", "processUuid", "status"'],
    ]) {
      const read = f.queries.findIndex(({ sql }) => sql.trim().startsWith(select));
      assert.ok(read > lock, `${table} se lee después de adquirir el bloqueo del crédito`);
    }
  });

  await t.test("una remisión reemplazada antes del PDF compone su sello con el mismo audio", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    const recordingId = uploaded.state.recording.id;
    const before = await f.read(id);
    await f.replacePhoto(id, "antes-del-pdf");
    const corrected = await f.read(id);
    assertVisibleAudio(corrected, recordingId);
    assert.ok(corrected.review.revision > before.review.revision);
    const recovered = await f.recoverPdf(id, processUuid);
    assertVisibleAudio(recovered, recordingId);
    assert.equal(recovered.document.available, true);
    const link = (await mappings(id))[0];
    assert.equal(link.sourceRevision, corrected.review.revision, "la fuente efectiva incluye la corrección autorizada previa");
  });

  await t.test("una foto reemplazada después del PDF conserva la continuidad sin aprobar", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    await f.recoverPdf(id, processUuid);
    await f.replacePhoto(id, "después-del-pdf");
    const corrected = await f.read(id);
    assertVisibleAudio(corrected, uploaded.state.recording.id);
    assert.equal(corrected.review.status, "PENDING");
  });

  await t.test("una novedad posterior al PDF conserva el audio y sigue bloqueando el OK", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    await f.recoverPdf(id, processUuid);
    await f.reportNovelty(id);
    const pending = await f.read(id);
    assertVisibleAudio(pending, uploaded.state.recording.id);
    assert.equal(pending.canApprove, false);
    assert.equal(pending.review.status, "PENDING");
  });

  await t.test("la última grabación B gana aunque A existiera al iniciar la descarga", async () => {
    const { id, processUuid } = await f.createCredit();
    const first = await f.upload(id, "A");
    await f.audit(id, processUuid, "REQUESTED");
    const second = await f.upload(id, "B");
    assert.notEqual(first.state.recording.id, second.state.recording.id);
    await f.recoverPdf(id, processUuid, { audit: false });
    await f.audit(id, processUuid, "RECOVERED");
    const recovered = await f.read(id);
    assertVisibleAudio(recovered, second.state.recording.id);
    assert.equal((await mappings(id))[0].recordingId, second.state.recording.id);
    assert.equal(await recordingCount(id), 2);
    assert.ok((await f.bytes(id, first.state.recording.id)).bytes.length > 0, "A permanece en la historia física");
  });

  await t.test("un PDF llegado sin auditoría de recuperación no habilita una grabación antigua", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    const recovered = await f.recoverPdf(id, processUuid, { audit: false });
    assert.equal(recovered.document.available, true);
    assert.equal(recovered.callRecording.recording, null);
    assert.equal((await mappings(id)).length, 0);
    assert.ok((await f.bytes(id, uploaded.state.recording.id)).bytes.length > 0, "el audio se conserva aunque no aplique a la nueva revisión");
  });

  await t.test("un cambio financiero previo impide revivir la grabación anterior", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    await f.database.query('UPDATE "Credito" SET "saldoBaseFinanciado"="saldoBaseFinanciado"+1000 WHERE "id"=$1', [id]);
    const changed = await f.recoverPdf(id, processUuid);
    assert.equal(changed.callRecording.recording, null);
    assert.equal((await mappings(id)).length, 0);
    assert.ok((await f.bytes(id, uploaded.state.recording.id)).bytes.length > 0);
    assert.match(text(recordingPanel(changed)), /Falta la grabación de esta revisión/);
    assert.doesNotMatch(text(recordingPanel(changed)), /se borró|eliminad/i);
  });

  for (const [label, mutation] of [
    ["celular", id => f.database.query('UPDATE "Credito" SET "clienteTelefono"=$2 WHERE "id"=$1', [id, "3119876543"])],
    ["correo", id => f.database.query('UPDATE "Credito" SET "clienteCorreo"=$2 WHERE "id"=$1', [id, "corregido@example.test"])],
    ["nombre", id => f.database.query('UPDATE "Credito" SET "clienteNombre"=$2 WHERE "id"=$1', [id, "Otro nombre sintético"])],
    ["cédula", id => f.database.query('UPDATE "Credito" SET "clienteDocumento"=$2 WHERE "id"=$1', [id, "100000099"])],
    ["IMEI", id => f.database.query('UPDATE "Credito" SET "imei"=$2 WHERE "id"=$1', [id, "000000000000099"])],
    ["evaluación DataCrédito", id => f.database.query('UPDATE "DataCreditoAssessment" SET "score"=740,"updatedAt"=CURRENT_TIMESTAMP WHERE "creditId"=$1', [id])],
  ]) await t.test(`cambiar ${label} durante la descarga impide asociar el audio anterior al PDF`, async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    const original = await f.physical(uploaded.state.recording.id);
    await f.audit(id, processUuid, "REQUESTED");
    await mutation(id);
    await f.recoverPdf(id, processUuid, { audit: false });
    await f.audit(id, processUuid, "RECOVERED");
    const changed = await f.read(id);
    assert.equal(changed.callRecording.recording, null);
    assert.equal((await mappings(id)).length, 0);
    assert.deepEqual(await f.physical(uploaded.state.recording.id), original);
  });

  for (const [label, mutation] of [
    ["plazo", id => f.database.query('UPDATE "Credito" SET "plazoMeses"=15 WHERE "id"=$1', [id])],
    ["frecuencia", id => f.database.query('UPDATE "Credito" SET "frecuenciaPago"=$2 WHERE "id"=$1', [id, "MENSUAL"])],
    ["valor de cuota", id => f.database.query('UPDATE "Credito" SET "valorCuota"=123456 WHERE "id"=$1', [id])],
    ["primer pago", id => f.database.query('UPDATE "Credito" SET "fechaPrimerPago"=$2::timestamp WHERE "id"=$1', [id, "2099-03-17T00:00:00"])],
    ["cuota comercial de amortización", id => f.database.query('INSERT INTO "CreditoAmortizacion" ("creditoId","cuotaComercial") VALUES ($1,125000)', [id])],
  ]) await t.test(`un cambio posterior de ${label} invalida el contexto aunque no incremente la revisión`, async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    const recovered = await f.recoverPdf(id, processUuid);
    assertVisibleAudio(recovered, uploaded.state.recording.id);
    const original = await f.physical(uploaded.state.recording.id);
    await mutation(id);
    const changed = await f.read(id);
    assert.equal(changed.review.revision, recovered.review.revision, "el campo no tiene un trigger de invalidación de aprobación");
    assert.equal(changed.callRecording.recording, null, "el vínculo debe rechazar un contexto financiero distinto");
    assert.equal((await mappings(id)).length, 1, "conserva el vínculo histórico, sin autorizar el contexto nuevo");
    assert.deepEqual(await f.physical(uploaded.state.recording.id), original);
  });

  await t.test("otra versión del PDF no reutiliza el permiso limitado a su primera recuperación", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    await f.recoverPdf(id, processUuid);
    const replacementPdf = Buffer.from(Buffer.from(pdf, "base64").toString() + "\n% different signed version").toString("base64");
    const changed = await f.recoverPdf(id, processUuid, { pdf: replacementPdf });
    assert.equal(changed.callRecording.recording, null);
    assert.equal((await mappings(id)).length, 1, "no crea un segundo vínculo para un documento distinto");
    assert.ok((await f.bytes(id, uploaded.state.recording.id)).bytes.length > 0);
  });

  await t.test("un sello de foto no convierte un audio grabado con PDF1 en una fuente sin PDF para PDF2", async () => {
    const { id, processUuid } = await f.createCredit();
    await f.recoverPdf(id, processUuid);
    const uploaded = await f.upload(id, "grabada-con-PDF1");
    const original = await f.physical(uploaded.state.recording.id);
    await f.replacePhoto(id, "corrección-posterior-a-PDF1");
    assertVisibleAudio(await f.read(id), uploaded.state.recording.id);
    assert.equal((await mappings(id)).length, 0, "el audio nació con el PDF1 ya disponible");
    const secondPdf = Buffer.from(Buffer.from(pdf, "base64").toString() + "\n% PDF2 different signed contract").toString("base64");
    const changed = await f.recoverPdf(id, processUuid, { pdf: secondPdf });
    assert.equal(changed.callRecording.recording, null,
      "la continuidad de una foto no prueba que el PDF anterior estuviera ausente");
    assert.equal((await mappings(id)).length, 0, "no debe crear una continuidad documental falsa para PDF2");
    assert.deepEqual(await f.physical(uploaded.state.recording.id), original);
  });

  await t.test("los vínculos de continuidad y los audios no se pueden editar, borrar ni truncar", async () => {
    const { id, processUuid } = await f.createCredit();
    const uploaded = await f.upload(id);
    await f.recoverPdf(id, processUuid);
    assertVisibleAudio(await f.read(id), uploaded.state.recording.id);
    for (const statement of [
      'UPDATE "CreditApprovalCallDocumentContinuation" SET "contextHash"="contextHash"',
      'DELETE FROM "CreditApprovalCallDocumentContinuation"',
      'TRUNCATE "CreditApprovalCallDocumentContinuation"',
      'UPDATE "CreditApprovalCallRecording" SET "fileName"="fileName"',
      'DELETE FROM "CreditApprovalCallRecording"',
      'TRUNCATE "CreditApprovalCallRecording" CASCADE',
    ]) await assert.rejects(f.database.exec(statement), error => error.code === "23514");
  });
});
