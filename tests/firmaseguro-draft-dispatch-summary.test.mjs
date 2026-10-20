import assert from "node:assert/strict";
import test from "node:test";
import { serializeDraftSignatureDispatch } from "../lib/firmaseguro-draft-dispatch-summary.ts";

const id = "00000000-0000-4000-8000-000000003433";
const source = {
  id, status: "PREPARING", actorUserId: 11,
  reason: "Envío del contrato de la solicitud a FirmaSeguro", expectedProcessUuid: null,
  createdAt: "2026-10-20T16:39:50.876Z", updatedAt: "2026-10-20T16:39:50.876Z", hasReceipt: false,
  hasProviderLocator: false,
  documentBase64: "PRIVATE-PDF", sourcePayload: { private: "PRIVATE-SOURCE" },
  requestPayload: { authorization: "PRIVATE-SECRET" },
};

test("el resumen revela un intento pendiente sin exponer contrato, proveedor ni identidad del actor", () => {
  const value = serializeDraftSignatureDispatch(source, { actorUserId: 11 });
  assert.deepEqual(value, {
    id, status: "PREPARING", pending: true, createdAt: source.createdAt,
    updatedAt: source.updatedAt, hasReceipt: false, canResume: true,
    failureStage: null, hasProviderLocator: false,
  });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|actorUserId|reason|sourcePayload|requestPayload|documentBase64|expectedProcessUuid/);
  assert.equal(source.documentBase64, "PRIVATE-PDF", "la lectura no modifica el intento original");
});

test("solo la preparación comercial nunca enviada del mismo actor puede reanudarse", () => {
  for (const patch of [
    { status: "DISPATCHING" }, { status: "UNCERTAIN" }, { hasReceipt: true },
    { hasReceipt: undefined }, { hasProviderLocator: true }, { hasProviderLocator: undefined },
    { actorUserId: 12 }, { reason: "Corrección de datos del cliente" },
    { expectedProcessUuid: "original-process" }, { expectedProcessUuid: undefined },
  ]) {
    const value = serializeDraftSignatureDispatch({ ...source, ...patch }, { actorUserId: 11 });
    assert.equal(value.pending, true);
    assert.equal(value.canResume, false, JSON.stringify(patch));
  }
  assert.equal(serializeDraftSignatureDispatch(source, { actorUserId: 99 }).canResume, false,
    "el administrador central no suplanta al asesor que reservó el envío");
  assert.equal(serializeDraftSignatureDispatch(source, { actorUserId: 0 }).canResume, false);
  assert.equal(serializeDraftSignatureDispatch({ ...source, failureStage: "private-provider-detail" }, { actorUserId: 11 }).failureStage, null);
  assert.equal(serializeDraftSignatureDispatch({ ...source, failureStage: "receipt_persistence", hasProviderLocator: true }, { actorUserId: 11 }).failureStage, "receipt_persistence");
});

test("no se inventa un pendiente a partir de intentos finalizados o datos inválidos", () => {
  for (const value of [null, [], "PREPARING", {}, { ...source, id: "bad-id" },
    { ...source, status: "AWAITING_SIGNATURE" }, { ...source, status: "FAILED_SAFE" }]) {
    assert.equal(serializeDraftSignatureDispatch(value, { actorUserId: 11 }), null);
  }
  const malformedDates = serializeDraftSignatureDispatch({ ...source, createdAt: "bad-date", updatedAt: null }, { actorUserId: 11 });
  assert.equal(malformedDates.createdAt, null);
  assert.equal(malformedDates.updatedAt, null);
});
