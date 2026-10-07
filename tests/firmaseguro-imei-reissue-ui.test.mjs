import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  firmaSeguroCorrectionReviewKey,
  hasFirmaSeguroCorrectionViewChanges,
  resolveFirmaSeguroDraftForSubmission,
} from "../lib/firmaseguro-draft-submit.ts";

const [factory, storage] = await Promise.all([
  readFile(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/solicitudes-storage.ts", import.meta.url), "utf8"),
]);

const correctedDraft = {
  id: 37,
  estado: "ABIERTO",
  imei: "490154203237518",
  payload: {
    imei: "490154203237518",
    firmaSeguroCorrectionPending: true,
    firmaSeguroCorrectionId: "75b29e9e-2e63-4e11-9841-1fad4c3b07f3",
  },
};

test("la corrección IMEI confirmada por el servidor usa el borrador sin reescribir el contrato", async () => {
  const calls = [];
  const result = await resolveFirmaSeguroDraftForSubmission({
    draftId: 37,
    loadDraft: async (id) => {
      calls.push(["load", id]);
      return { ok: true, item: correctedDraft };
    },
    saveDraft: async () => {
      calls.push(["save"]);
      return 37;
    },
  });
  assert.equal(result.draftId, 37);
  assert.deepEqual(result.correctionDraft, correctedDraft);
  assert.deepEqual(calls, [["load", 37]]);
});

test("sin corrección IMEI auditada conserva el guardado previo; un marcador textual no lo elude", async () => {
  for (const payload of [{ imei: correctedDraft.imei }, { firmaSeguroCorrectionPending: "true" }]) {
    const calls = [];
    const result = await resolveFirmaSeguroDraftForSubmission({
      draftId: 37,
      loadDraft: async (id) => {
        calls.push(["load", id]);
        return { ok: true, item: { ...correctedDraft, payload } };
      },
      saveDraft: async () => {
        calls.push(["save"]);
        return 37;
      },
    });
    assert.equal(result.draftId, 37);
    assert.equal(result.correctionDraft, null);
    assert.deepEqual(calls, [["load", 37], ["save"]]);
  }
});

test("un borrador nuevo se guarda sin consultar una corrección anterior", async () => {
  const calls = [];
  const result = await resolveFirmaSeguroDraftForSubmission({
    draftId: null,
    loadDraft: async () => {
      calls.push(["load"]);
      throw new Error("No debe cargar un borrador inexistente");
    },
    saveDraft: async () => {
      calls.push(["save"]);
      return 52;
    },
  });
  assert.equal(result.draftId, 52);
  assert.equal(result.correctionDraft, null);
  assert.deepEqual(calls, [["save"]]);
});

test("un GET fallido, otro ID o una solicitud cerrada impiden el envío", async () => {
  for (const loadDraft of [
    async () => ({ ok: false, error: "Sin respuesta del servidor" }),
    async () => ({ ok: true, item: { ...correctedDraft, id: 38 } }),
    async () => ({ ok: true, item: { ...correctedDraft, estado: "CERRADO" } }),
  ]) {
    let saved = false;
    await assert.rejects(resolveFirmaSeguroDraftForSubmission({
      draftId: 37,
      loadDraft,
      saveDraft: async () => {
        saved = true;
        return 37;
      },
    }));
    assert.equal(saved, false);
  }
});

test("nombre, valor o fecha visibles distintos exigen cargar el contrato autoritativo", () => {
  const authoritative = {
    clienteNombre: "CLIENTE VIGENTE",
    valorEquipoTotal: 2_000_000,
    fechaPrimerPago: "2026-10-17",
    imei: "490154203237518",
  };
  for (const change of [
    { clienteNombre: "OTRO NOMBRE" },
    { valorEquipoTotal: 2_100_000 },
    { fechaPrimerPago: "2026-11-02" },
  ]) {
    assert.equal(
      hasFirmaSeguroCorrectionViewChanges({ ...authoritative, ...change }, authoritative),
      true,
    );
  }
  assert.equal(hasFirmaSeguroCorrectionViewChanges({
    ...authoritative,
    valorEquipoTotal: "2000000",
    fotoRemisionDataUrl: "data:image/png;base64,ANTIGUA",
  }, authoritative), false);
});

test("la revisión reconoce una sola versión del contrato; otra corrección exige revisar de nuevo", () => {
  const draft = {
    ...correctedDraft,
    payload: {
      ...correctedDraft.payload,
      fechaPrimerPago: "2026-10-17",
      frecuenciaPago: "QUINCENAL",
    },
  };
  const reviewed = firmaSeguroCorrectionReviewKey(draft);
  assert.equal(firmaSeguroCorrectionReviewKey({ ...draft, updatedAt: "later" }), reviewed);
  assert.notEqual(firmaSeguroCorrectionReviewKey({
    ...draft,
    payload: { ...draft.payload, fechaPrimerPago: "2026-11-02" },
  }), reviewed);
  assert.notEqual(firmaSeguroCorrectionReviewKey({
    ...draft,
    payload: { ...draft.payload, frecuenciaPago: "MENSUAL" },
  }), reviewed);
  assert.notEqual(firmaSeguroCorrectionReviewKey({
    ...draft,
    payload: { ...draft.payload, firmaSeguroCorrectionId: "otra-version" },
  }), reviewed);
});

test("la fábrica elige el borrador antes del POST y la inmutabilidad del servidor sigue activa", () => {
  const start = factory.indexOf("const handleFirmaSeguroStepReady = async () => {");
  const end = factory.indexOf("const finalizeFirmaSeguroDelivery = async () => {", start);
  assert.ok(start >= 0 && end > start);
  const handler = factory.slice(start, end);
  const selector = handler.match(/await resolveFirmaSeguroDraftForSubmission(?:<[^>]+>)?\(/);
  assert.ok(selector, "El envío debe consultar el borrador autoritativo primero");
  assert.match(handler, /await submitFirmaSeguroDraft\(currentDraftId\)/);
  assert.ok(handler.indexOf(selector[0]) <
    handler.indexOf("await submitFirmaSeguroDraft(currentDraftId)"));
  assert.match(handler,
    /const reviewKey = firmaSeguroCorrectionReviewKey\(correctionDraft\);[\s\S]*?hasFirmaSeguroCorrectionViewChanges\([\s\S]*?firmaSeguroCorrectionReviewKeyRef\.current !== reviewKey\) \{[\s\S]*?firmaSeguroCorrectionReviewKeyRef\.current = reviewKey;[\s\S]*?applyDraftPayload\(correctionDraft\);[\s\S]*?return;[\s\S]*?\}\s*\}\s*const signature = await submitFirmaSeguroDraft\(currentDraftId\)/);
  assert.doesNotMatch(handler, /const currentDraftId = await saveCurrentDraft\(4\)/);
  assert.match(handler, /if \(!correctionDraft\) \{\s*await saveDraftPayloadForVeriff\(/);
  assert.match(storage, /function preservePendingImeiCorrectionAutosave\(/);
  assert.match(storage, /throw new SolicitudCanonicalMutationError\("SOLICITUD_TERMINOS_FIRMADOS_INMUTABLE"\)/);
});

test("la pantalla conserva fecha y frecuencia firmadas tras hidratar una corrección IMEI", () => {
  assert.match(factory, /if \(!serverFirstPaymentDate \|\| firmaSeguroDraftCorrectionPending \|\|[\s\S]*?firmaSeguroDraftProcess\?\.frozenCorrectionReissue\) return;/);
  assert.match(factory, /firmaSeguroDraftCorrectionPending && firmaSeguroSignedCorrectionFrequency[\s\S]*?normalizePaymentFrequency\(firmaSeguroSignedCorrectionFrequency\)/);
  assert.match(factory, /setFirmaSeguroSignedCorrectionFrequency\([\s\S]*?checked\("firmaSeguroCorrectionPending"\) \? restoredPaymentFrequency : null/);
});
