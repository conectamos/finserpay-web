import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isRecoverableVeriffSessionReservation } = await jiti.import(
  "../lib/veriff-session-recovery.ts"
);

const draft = {
  aliadoId: 10,
  documentNumber: "1.105.616.341",
  id: 1348,
  sedeId: 20,
};
const orphan = {
  aliadoId: 10,
  creditoId: null,
  decidedAt: null,
  documentNumber: "1105616341",
  draftId: 1348,
  sedeId: 20,
  sessionId: null,
  status: "PENDING",
};

test("permite reemplazar la reserva técnica PENDING o ERROR sin sesión", () => {
  assert.equal(isRecoverableVeriffSessionReservation({ draft, validation: orphan }), true);
  assert.equal(
    isRecoverableVeriffSessionReservation({
      draft,
      validation: { ...orphan, status: "ERROR" },
    }),
    true
  );
});

test("no reemplaza una validación con sesión, decisión, crédito o alcance distinto", () => {
  const blocked = [
    { ...orphan, sessionId: "session-1" },
    { ...orphan, decidedAt: "2026-09-15T20:00:00.000Z" },
    { ...orphan, creditoId: 99 },
    { ...orphan, draftId: 1349 },
    { ...orphan, sedeId: 21 },
    { ...orphan, aliadoId: 11 },
    { ...orphan, documentNumber: "1105616342" },
    { ...orphan, status: "APPROVED" },
    { ...orphan, status: "DECLINED" },
  ];

  for (const validation of blocked) {
    assert.equal(
      isRecoverableVeriffSessionReservation({ draft, validation }),
      false
    );
  }
});
