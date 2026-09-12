import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ApprovalRequestError,
  readApprovalQueue,
  mergeApprovalQueuePage,
  uploadApprovalCallRecording,
  approveCreditReview,
  requestApprovalSignature,
  refreshApprovalSignature,
  readApprovalCredit,
  searchApprovalCredits,
} from "../app/dashboard/aprobaciones/approval-client.ts";

test("busca únicamente la cédula indicada y evita caché del expediente", async (t) => {
  const controller = new AbortController();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ items: [{ id: 81 }, { id: 92 }] });
  });

  const items = await searchApprovalCredits("123456789", controller.signal);
  assert.equal(items.length, 2, "Conserva todos los folios para que el analista seleccione");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/aprobaciones?documento=123456789");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.signal, controller.signal);
});

test("rechaza respuestas que mezclan el expediente con otro crédito", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ item: { id: 92 } }));
  await assert.rejects(readApprovalCredit(81), /no corresponde al crédito seleccionado/);
});

test("un OK envía la revisión y huella que vio el analista, sin modificar el expediente", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  });

  await approveCreditReview(81, 3, "review-of-signed-evidence");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/aprobaciones/81");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    revision: 3,
    reviewHash: "review-of-signed-evidence",
  });
});

test("un expediente cambiado produce conflicto y nunca reintenta aprobar automáticamente", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return Response.json({ error: "La documentación cambió" }, { status: 409 });
  });

  await assert.rejects(approveCreditReview(81, 1, "old-review"), (error) => {
    assert.ok(error instanceof ApprovalRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "La documentación cambió");
    return true;
  });
  assert.equal(requests, 1, "La revisión nueva necesita una decisión explícita");
});

test("mantiene el conflicto aunque el proxy no entregue JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Conflict", { status: 409 }));
  await assert.rejects(approveCreditReview(81, 1, "old-review"), (error) => error instanceof ApprovalRequestError && error.status === 409);
});

test("un corte de conexión no repite una aprobación cuyo resultado se desconoce", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(approveCreditReview(81, 1, "review"), /Failed to fetch/);
  assert.equal(requests, 1);
});

test("no convierte una respuesta incompleta de búsqueda en una lista vacía válida", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  await assert.rejects(searchApprovalCredits("123456789"), /respuesta válida/);
});

test("el panel mantiene el visor y separa las correcciones del OK", async () => {
  const panel = await readFile(new URL("../app/dashboard/aprobaciones/approval-console.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /type=["']file["']|ApprovedCreditEvidenceCorrection|method:\s*["'](?:PATCH|PUT|DELETE)["']/);
  assert.match(panel, /<ConfirmDialog/);
  assert.match(panel, /<LastPdfPagePreview/);
  assert.match(panel, /<ApprovalEvidenceCorrection/);
  assert.match(panel, /<ApprovalSignatureReissue/);
  assert.match(panel, /correctionBusy \|\| signatureBusy/);
  assert.doesNotMatch(panel, /<iframe|Abrir PDF firmado/);
  assert.match(panel, /reviewChanged \|\| rereviewed/);
});

test("solo muestra éxito cuando el servidor confirma que aprobó", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(approveCreditReview(81, 1, "review"), /No se recibió confirmación/);
});

test("el reenvío envía solo la versión observada, motivo e identificador idempotente", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true }); });
  const input = { expectedRevision: 3, expectedProcessUuid: "original-process", reason: "Firma incompleta del cliente", idempotencyKey: "11111111-1111-4111-8111-111111111111" };
  await requestApprovalSignature(81, input);
  assert.equal(calls[0].url, "/api/aprobaciones/81/firma-seguro");
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: "REQUEST", ...input });
  await refreshApprovalSignature(81, input.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[1].options.body), { action: "REFRESH", operationId: input.idempotencyKey });
});

test("un reenvío de resultado incierto no se repite ni se presenta como exitoso", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Connection lost"); });
  await assert.rejects(requestApprovalSignature(81, { expectedRevision: 3, expectedProcessUuid: "process", reason: "Firma incompleta", idempotencyKey: "test" }), /Connection lost/);
  assert.equal(calls, 1);
});

test("Aprobadas consulta y valida solo aprobaciones vigentes sin mezclar pendientes", async (t) => {
  let result = { items: [{ id: 81, status: "APPROVED", required: true }], nextCursor: null, hasMore: false };
  t.mock.method(globalThis, "fetch", async (url) => { assert.equal(url, "/api/aprobaciones?view=approved"); return Response.json(result); });
  assert.equal((await readApprovalQueue(null, undefined, "approved")).items.length, 1);
  assert.deepEqual(mergeApprovalQueuePage([], result.items, false, "approved"), result.items);
  assert.equal(mergeApprovalQueuePage([], result.items, false).length, 0);
  result = { ...result, items: [{ id: 82, status: "PENDING", required: true }] };
  await assert.rejects(readApprovalQueue(null, undefined, "approved"), /respuesta válida/);
});

test("la grabación se envía binaria y el OK queda asociado al audio revisado", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options }); return Response.json({ ok: true, state: { recording: { id: "audio-id" } }, unchanged: false });
  });
  const file = new File(["synthetic"], "llamada cliente.wav", { type: "audio/wav" });
  await uploadApprovalCallRecording(81, { file, revision: 2, reviewHash: "hash", idempotencyKey: "operation-id" });
  assert.equal(requests[0].url, "/api/aprobaciones/81/grabaciones");
  assert.equal(requests[0].options.body, file);
  assert.equal(requests[0].options.headers["Content-Type"], "application/octet-stream");
  assert.equal(requests[0].options.headers["x-recording-file-name"], "llamada%20cliente.wav");
  assert.equal(requests[0].options.headers["x-review-revision"], "2");
  assert.equal(requests[0].options.headers["idempotency-key"], "operation-id");
  await approveCreditReview(81, 2, "hash", "audio-id");
  assert.deepEqual(JSON.parse(requests[1].options.body), { revision: 2, reviewHash: "hash", recordingId: "audio-id" });
});

test("la búsqueda compartida envía filtro y solicita contadores completos", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const params = new URL(url, "https://finser.test").searchParams;
    assert.equal(params.get("q"), "Cliente % literal"); assert.equal(params.get("counts"), "1");
    assert.equal(params.get("view"), "pending"); assert.equal(params.get("cursor"), "next"); assert.equal(options.cache, "no-store");
    return Response.json({ items: [{ id: 81, required: true, status: "PENDING" }], hasMore: false, nextCursor: null, counts: { pending: 105, approved: 8 } });
  });
  const result = await readApprovalQueue("next", undefined, "pending", { query: "Cliente % literal", counts: true });
  assert.deepEqual(result.counts, { pending: 105, approved: 8 });
});

test("contadores ausentes o inválidos no se muestran como cero", async (t) => {
  let counts;
  t.mock.method(globalThis, "fetch", async () => Response.json({ items: [], hasMore: false, nextCursor: null, counts }));
  for (const invalid of [undefined, null, { pending: -1, approved: 0 }, { pending: 1.5, approved: 0 }, { pending: 2, approved: "3" }]) {
    counts = invalid;
    await assert.rejects(readApprovalQueue(null, undefined, "pending", { counts: true }), /contadores/);
  }
});
