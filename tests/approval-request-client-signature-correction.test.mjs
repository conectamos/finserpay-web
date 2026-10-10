import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { clientCorrectionCase, clone, core, frozen, load, operational, seals, statuses } from "./firmaseguro-client-correction-fixture.mjs";

const actor = { id: 7, nombre: "Analista nominal" };
function fixture(options = {}) {
  const state = clientCorrectionCase(options);
  if (options.clientRetry) {
    state.draft.payload = clone(state.updatedPayload);
    state.draft.clienteNombre = state.updatedPayload.clienteNombre;
    state.draft.clienteTelefono = state.updatedPayload.clienteTelefono;
    state.source = { ...state.process, status: options.terminalStatus || "REJECTED",
      signedDocumentBase64: null, completedAt: null };
  }
  const operations = new Map();
  const calls = { state: 0, sql: 0, refresh: 0, pdf: 0, reserve: 0, prepare: 0, send: 0, finalize: 0 };
  let rendered = null, reserved = null;
  async function detail() {
    calls.state++;
    const unresolved = [...operations.values()].some(row => ["PREPARING", "DISPATCHING", "UNCERTAIN"].includes(row.status));
    const pending = unresolved;
    return { values: core.requestDataValues(state.draft.payload), revision: core.requestDataRevision(state.draft.payload),
      editableFields: pending || options.locked ? [] : [...core.REQUEST_CORRECTION_FIELDS],
      requiresNewSignature: options.requiresNewSignature !== false,
      expectedProcessUuid: state.source.processUuid, reason: pending ? "Hay un envío pendiente de conciliación." : null };
  }
  const ledger = {
    getDraftDispatch: async id => operations.get(id) || null,
    getDraftDispatchReceipt: async id => options.receipt && operations.has(id) ? { dispatchId: id } : null,
    reserveDraftDispatch: async input => {
      calls.reserve++; reserved = input;
      assert.equal(input.draftId, state.draft.id);
      assert.equal(input.supersedeActive, true);
      assert.deepEqual(input.sourcePayload, state.draft.payload);
      assert.equal(input.document.subarray(0, 5).toString(), "%PDF-");
      assert.equal(seals.readFinancingTermsSeal(input.updatedPayload.financialTermsSeal)?.checksum,
        input.draftPayload.firmaSeguroFrozenClientCorrectionSource.targetChecksum);
      if (options.reserveError) throw options.reserveError;
      const row = { ...input, actorUserId: input.actor.id, actorName: input.actor.nombre,
        status: "PREPARING", processUuid: null };
      operations.set(row.id, row); return row;
    },
    dispatchReservedDraft: async id => {
      const row = operations.get(id); assert.equal(row.status, "PREPARING"); calls.prepare++;
      if (options.prepareError) {
        row.status = "FAILED_SAFE";
        throw new Error("No se pudo preparar la firma antes del envío");
      }
      row.status = "DISPATCHING";
      state.draft.payload = clone(row.updatedPayload);
      state.draft.clienteNombre = row.updatedPayload.clienteNombre;
      state.draft.clienteTelefono = row.updatedPayload.clienteTelefono;
      calls.send++;
      if (options.uncertain) {
        row.status = "UNCERTAIN";
        throw new Error("Se perdió la respuesta del proveedor después del envío");
      }
      row.status = "AWAITING_SIGNATURE"; row.processUuid = "new-process";
      return row;
    },
    finalizeDraftDispatch: async id => {
      calls.finalize++; const row = operations.get(id);
      row.status = "AWAITING_SIGNATURE"; row.processUuid = "new-process"; return row;
    },
  };
  const service = load("lib/approval-request-client-signature-correction.ts", {
    "@/lib/prisma": { default: { $queryRawUnsafe: async (sql, ...values) => {
      calls.sql++;
      if (sql.includes('FROM "ApprovalOperationalAction"')) {
        const row = operations.get(values[0]);
        return [{ saved: Boolean(row && row.status !== "PREPARING" && row.status !== "FAILED_SAFE") }];
      }
      if (sql.includes('FROM "CreditoBorrador"')) return options.noDraft ? [] : [state.draft];
      if (sql.includes('FROM "FirmaSeguroProcess"')) return options.noSource ? [] : options.multipleSources
        ? [state.source, { ...state.source, processUuid: "ambiguous-second-process" }] : [state.source];
      throw new Error("Unexpected SQL read");
    } } },
    "@/lib/approval-request-correction": { getAnalystRequestCorrection: detail },
    "@/lib/approval-request-correction-core": core,
    "@/lib/firmaseguro-credit": { refreshFirmaSeguroProcess: async process => {
      calls.refresh++;
      if (options.refreshError) throw new Error("Provider unavailable");
      return options.refreshed ? { ...process, ...options.refreshed } : process;
    } },
    "@/lib/approval-operations-core": operational,
    "@/lib/firmaseguro-status": statuses,
    "@/lib/firmaseguro": { isFirmaSeguroCompletedStatus: value => statuses.isFirmaSeguroSuccessfulStatus(value) &&
      !statuses.isFirmaSeguroFailedStatus(value) },
    "@/lib/credit-amortization-contract": seals,
    "@/lib/firmaseguro-draft-client-correction-frozen": frozen,
    "@/lib/firmaseguro-folio-pdf": { buildFirmaSeguroCreditPdf: async credit => {
      calls.pdf++; rendered = credit;
      if (options.pdfError) throw new Error("PDF preparation failed");
      return options.invalidPdf ? Buffer.from("invalid document") : Buffer.from("%PDF-1.7\n" + JSON.stringify(credit) + "\n%%EOF");
    } },
    "@/lib/firmaseguro-draft-dispatch-ledger": ledger,
  });
  return { ...state, state, operations, calls, run: (input = state.input, selectedActor = actor) =>
    service.correctAndReissueAnalystRequestData(state.draft.id, input, selectedActor),
    retry: (input, selectedActor = actor) => service.retryAnalystRequestClientSignature(state.draft.id, input, selectedActor),
    get rendered() { return rendered; }, get reserved() { return reserved; } };
}

for (const signed of [false, true]) {
  test(`corregir datos del contrato ${signed ? "firmado" : "pendiente"} crea una sola nueva firma y conserva las condiciones`, async () => {
    const f = fixture({ signed }); const sourceBefore = clone(f.source);
    const result = await f.run();
    assert.equal(result.signature.status, "AWAITING_SIGNATURE");
    assert.equal(result.signature.saved, true);
    assert.match(result.signature.message, /Esperando la firma del cliente/);
    assert.equal(f.calls.refresh, signed ? 0 : 1);
    assert.equal(f.calls.pdf, 1); assert.equal(f.calls.reserve, 1); assert.equal(f.calls.send, 1);
    assert.deepEqual(f.source, sourceBefore, "el servicio no muta ni borra el contrato original");
    assert.equal(f.rendered.clienteNombre, "CARLOS ANDRES RIVERA GOMEZ");
    assert.equal(f.rendered.clientePrimerApellido, f.original.clientePrimerApellido);
    assert.equal(f.rendered.clienteDocumento, f.original.clienteDocumento);
    assert.equal(f.rendered.clienteTelefono, "3111234567");
    assert.equal(f.rendered.clienteDireccion, "CARRERA 7 # 12-34 CENTRO");
    assert.equal(f.rendered.fechaPrimerPago, f.original.fechaPrimerPago);
    const mutable = new Set(["clienteNombre", "clienteTelefono", "clienteCorreo", "clienteDireccion"]);
    for (const key of Object.keys(f.seal.snapshot)) if (!mutable.has(key))
      assert.equal(f.reserved.updatedPayload.financialTermsSeal.snapshot[key], f.seal.snapshot[key], key);
    assert.equal(f.reserved.updatedPayload.firmaSeguroClientCorrectionPending, true);
    assert.equal(f.reserved.updatedPayload.firmaSeguroClientCorrectionSourceSigned, signed);
    assert.equal(f.reserved.updatedPayload.entregaValidada, false);
    assert.equal(f.reserved.updatedPayload.deliverableReady, false);
    assert.equal(f.reserved.updatedPayload.analystDataCorrection.actorName, actor.nombre);
    assert.ok(f.reserved.updatedPayload.analystDataCorrection.updatedAt);
    assert.equal(f.reserved.updatedPayload.contratoCedulaFrenteDataUrl, f.original.contratoCedulaFrenteDataUrl,
      "corregir nombres no borra los soportes de identidad existentes");
    assert.equal(f.reserved.draftPayload.clienteFechaNacimiento, "1985-05-19");
    assert.equal(f.reserved.sourcePayload.fotoEntregaDataUrl, f.original.fotoEntregaDataUrl,
      "el contrato anterior conserva su foto en el origen archivado del envío");
    assert.equal(f.reserved.sourcePayload.fotoRemisionDataUrl, f.original.fotoRemisionDataUrl);
  });
}

test("corregir sólo contacto conserva los nombres Veriff del proceso; los claims del borrador no los sustituyen", async () => {
  const f = fixture({ signed: true });
  const metadata = { source: "VERIFF", validationId: 42, documentNumber: f.original.clienteDocumento,
    canonicalFullName: f.original.clienteNombre, firstName: "NOMBRES VERIFF", firstLastName: "APELLIDOS VERIFF",
    secondName: null, secondLastName: null };
  f.source.draftPayload.firmaSeguroContractNameVersion = 1;
  f.source.draftPayload.firmaSeguroIdentity = metadata;
  f.state.draft.payload.firmaSeguroContractNameVersion = 1;
  f.state.draft.payload.firmaSeguroIdentity = { ...metadata, firstName: "CLAIM NO CONFIABLE" };
  const input = { ...f.input, values: { ...f.input.values,
    clientePrimerNombre: f.original.clientePrimerNombre,
    clienteSegundoApellido: f.original.clienteSegundoApellido } };
  await f.run(input);
  assert.equal(f.reserved.draftPayload.firmaSeguroContractNameVersion, 1);
  assert.deepEqual(f.reserved.draftPayload.firmaSeguroIdentity, metadata);
  assert.equal(f.calls.send, 1);
  const renamed = fixture({ signed: true });
  renamed.state.draft.payload.firmaSeguroContractNameVersion = 1;
  renamed.state.draft.payload.firmaSeguroIdentity = metadata;
  await renamed.run();
  assert.equal(renamed.reserved.draftPayload.firmaSeguroContractNameVersion, undefined);
  assert.equal(renamed.reserved.draftPayload.firmaSeguroIdentity, undefined);
});

test("reintentar la misma confirmación entrega el resultado guardado y no vuelve a generar PDF ni enviar", async () => {
  const f = fixture({ signed: true }); const first = await f.run();
  const counters = { ...f.calls };
  const replay = await f.run();
  assert.equal(replay.signature.id, first.signature.id);
  assert.equal(replay.signature.processUuid, first.signature.processUuid);
  assert.equal(replay.signature.status, "AWAITING_SIGNATURE");
  for (const field of ["refresh", "pdf", "reserve", "prepare", "send", "finalize"])
    assert.equal(f.calls[field], counters[field], field);
});

test("el mismo identificador con otro cambio, motivo, actor o proceso produce conflicto sin enviar", async () => {
  const f = fixture({ signed: true }); await f.run();
  for (const input of [
    { ...f.input, values: { ...f.input.values, clienteTelefono: "3121234567" } },
    { ...f.input, expectedRevision: 99 },
    { ...f.input, reason: "Motivo distinto para otra corrección" },
    { ...f.input, expectedProcessUuid: "otro-proceso" },
  ]) await assert.rejects(f.run(input), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(f.run(f.input, { ...actor, id: actor.id + 1 }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(f.calls.send, 1); assert.equal(f.calls.pdf, 1);
});

test("la preparación fallida conserva el borrador y la firma originales; repetirla no envía", async () => {
  const f = fixture({ signed: true, prepareError: true });
  const beforeDraft = clone(f.state.draft), beforeSource = clone(f.source);
  const result = await f.run();
  assert.equal(result.signature.status, "FAILED_SAFE");
  assert.equal(result.signature.saved, false);
  assert.match(result.signature.message, /No se enviaron ni guardaron los cambios/);
  assert.deepEqual(f.state.draft, beforeDraft); assert.deepEqual(f.source, beforeSource);
  assert.equal(f.calls.send, 0);
  await f.run(); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.send, 0);
});

test("un resultado UNCERTAIN se conserva y bloquea repeticiones con el mismo y con un nuevo identificador", async () => {
  const f = fixture({ uncertain: true });
  const first = await f.run();
  assert.equal(first.signature.status, "UNCERTAIN");
  assert.match(first.signature.message, /no repitas la solicitud/);
  assert.equal(f.operations.get(f.input.idempotencyKey).status, "UNCERTAIN");
  const replay = await f.run(); assert.equal(replay.signature.status, "UNCERTAIN");
  await assert.rejects(f.run({ ...f.input, idempotencyKey: randomUUID() }), { code: "REQUEST_LOCKED" });
  assert.equal(f.calls.send, 1); assert.equal(f.calls.prepare, 1);
});

test("una respuesta duradera posterior finaliza UNCERTAIN sin efectuar un segundo envío", async () => {
  const options = { uncertain: true }; const f = fixture(options);
  await f.run(); options.receipt = true;
  const recovered = await f.run();
  assert.equal(recovered.signature.status, "AWAITING_SIGNATURE");
  assert.equal(f.calls.finalize, 1); assert.equal(f.calls.send, 1);
});

test("una firma ausente, ambigua o distinta se rechaza antes de generar documentos y reservar", async () => {
  for (const setup of [{ noSource: true }, { multipleSources: true }, { noDraft: true }]) {
    const f = fixture(setup);
    await assert.rejects(f.run(), error => ["PROCESS_CHANGED", "REQUEST_LOCKED"].includes(error.code));
    assert.equal(f.calls.pdf, 0); assert.equal(f.calls.reserve, 0); assert.equal(f.calls.send, 0);
  }
  const f = fixture();
  await assert.rejects(f.run({ ...f.input, expectedProcessUuid: "otro-proceso" }), { code: "PROCESS_CHANGED" });
  assert.equal(f.calls.sql, 0);
});

test("los datos no coincidentes o cifras manipuladas se rechazan conservando el borrador", async () => {
  for (const mutation of [
    state => { state.draft.payload.cuotaInicial = 1; },
    state => { state.draft.payload.fechaPrimerPago = "2026-11-17"; },
    state => { state.draft.payload.imei = "123456789012345"; },
    state => { state.draft.clienteDocumento = "111111111"; },
    state => { state.source.draftPayload.financialTermsSeal.snapshot.totalPagar = "1.000000"; },
  ]) {
    const f = fixture({ signed: true }); mutation(f.state); const previous = clone(f.state.draft);
    await assert.rejects(f.run(), { code: "CONTRACT_NOT_VERIFIED" });
    assert.equal(f.calls.pdf, 0); assert.equal(f.calls.reserve, 0);
    assert.deepEqual(f.state.draft, previous);
  }
});

test("primer apellido, cédula y campos financieros permanecen excluidos del contrato corregible", async () => {
  const f = fixture({ signed: true });
  for (const field of ["clienteDocumento", "clientePrimerApellido", "valorEquipoTotal", "cuotaInicial", "plazoMeses", "fechaPrimerPago"])
    assert.throws(() => core.parseRequestDataCorrection({ ...f.input,
      values: { [field]: "DATO DISTINTO" }, expectedValues: { [field]: String(f.original[field]) } }), { code: "INVALID_FIELDS" });
  assert.equal(f.calls.pdf, 0); assert.equal(f.calls.reserve, 0); assert.equal(f.calls.send, 0);
});

test("errores de consulta y estados no verificados del proveedor no guardan cambios ni reenvían", async () => {
  for (const options of [{ refreshError: true }, { refreshed: { status: "UNKNOWN" } },
    { refreshed: { status: "CREATED", lastError: "provider error" } },
    { refreshed: { supersededAt: new Date() } }, { refreshed: { completedAt: new Date(), signedDocumentBase64: null } }]) {
    const f = fixture(options); const previous = clone(f.state.draft);
    await assert.rejects(f.run(), error => ["SIGNATURE_REFRESH_FAILED", "SIGNATURE_NOT_VERIFIED", "PROCESS_CHANGED"].includes(error.code));
    assert.deepEqual(f.state.draft, previous);
    assert.equal(f.calls.reserve, 0); assert.equal(f.calls.send, 0);
  }
});

test("sin confirmación, usuario nominal o PDF válido no se reserva ni modifica la solicitud", async () => {
  const f = fixture({ signed: true });
  await assert.rejects(f.run({ ...f.input, confirmed: false }), { code: "CONFIRM_NEW_SIGNATURE" });
  await assert.rejects(f.run(f.input, { id: 0, nombre: "Sin sesión" }), { code: "UNAUTHORIZED" });
  const invalid = fixture({ signed: true, invalidPdf: true });
  const previous = clone(invalid.state.draft);
  await assert.rejects(invalid.run(), { code: "CONTRACT_DOCUMENT_INVALID" });
  assert.deepEqual(invalid.state.draft, previous); assert.equal(invalid.calls.reserve, 0);
});

test("el fallo definitivo de una firma corregida permite reenviar los mismos datos y conserva fecha y condiciones", async () => {
  const f = fixture({ clientRetry: true });
  const sourceSeal = clone(f.state.source.draftPayload.financialTermsSeal);
  const originalClient = core.requestDataValues(f.state.draft.payload);
  const request = { idempotencyKey: randomUUID(), expectedProcessUuid: f.state.source.processUuid,
    reason: "Reenviar después del rechazo confirmado por el proveedor" };
  assert.notEqual(request.idempotencyKey, f.input.idempotencyKey);
  const sent = await f.retry(request);
  assert.equal(sent.status, "AWAITING_SIGNATURE"); assert.equal(sent.saved, true);
  assert.equal(f.calls.refresh, 1);
  assert.equal(f.calls.send, 1);
  assert.equal(f.reserved.updatedPayload.firmaSeguroClientCorrectionId, request.idempotencyKey);
  assert.deepEqual(core.requestDataValues(f.reserved.updatedPayload), originalClient);
  assert.deepEqual(f.reserved.updatedPayload.financialTermsSeal, sourceSeal);
  assert.equal(f.rendered.fechaPrimerPago, sourceSeal.snapshot.fechaPrimerPago);
  const replay = await f.retry(request);
  assert.equal(replay.id, sent.id); assert.equal(replay.status, "AWAITING_SIGNATURE");
  assert.equal(f.calls.send, 1); assert.equal(f.calls.pdf, 1);
});

test("la firma corregida que sigue pendiente o tiene fallo técnico sin confirmación no puede reenviarse", async () => {
  for (const terminalStatus of ["CREATED", "PENDING", "ERROR", "UNKNOWN", "NOT_SIGNED"]) {
    const f = fixture({ clientRetry: true, terminalStatus });
    await assert.rejects(f.retry({ idempotencyKey: randomUUID(), expectedProcessUuid: f.state.source.processUuid,
      reason: "Intento de reenvío sin fallo definitivo" }), error =>
      ["REQUEST_LOCKED", "SIGNATURE_NOT_FAILED"].includes(error.code), terminalStatus);
    assert.equal(f.calls.pdf, 0); assert.equal(f.calls.reserve, 0); assert.equal(f.calls.send, 0);
  }
});

test("un cambio del proveedor a pendiente durante la consulta fresca bloquea el reenvío del fallo anterior", async () => {
  const f = fixture({ clientRetry: true, refreshed: { status: "CREATED" } });
  await assert.rejects(f.retry({ idempotencyKey: randomUUID(), expectedProcessUuid: f.state.source.processUuid,
    reason: "Reenviar una versión rechazada" }), { code: "SIGNATURE_NOT_FAILED" });
  assert.equal(f.calls.refresh, 1); assert.equal(f.calls.send, 0);
});
