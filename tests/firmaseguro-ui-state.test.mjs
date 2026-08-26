import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  formatFirmaSeguroApiFailure,
  formatFirmaSeguroProcessIssue,
  isFirmaSeguroSuccessfulProcess,
  resolveFirmaSeguroProcessUiState,
} = await jiti.import("../app/dashboard/creditos/firmaseguro-ui.ts");

test("separa procesos en espera de estados terminales fallidos", () => {
  assert.equal(
    resolveFirmaSeguroProcessUiState({
      processUuid: "uuid-en-espera",
      status: "IN_PROGRESS",
    }),
    "waiting"
  );

  for (const status of [
    "ERROR",
    "PROCESS_FAILED",
    "CANCELLED",
    "Proceso cancelado",
    "REJECTED",
    "EXPIRADO",
  ]) {
    assert.equal(
      resolveFirmaSeguroProcessUiState({ processUuid: "uuid-error", status }),
      "error",
      status
    );
  }

  assert.equal(
    resolveFirmaSeguroProcessUiState({
      processUuid: "uuid-error",
      status: "IN_PROGRESS",
      lastError: "El proveedor no pudo entregar el mensaje",
    }),
    "error"
  );
  assert.equal(resolveFirmaSeguroProcessUiState(null), "pending");
});

test("la evidencia firmada prevalece sobre errores históricos", () => {
  const process = {
    processUuid: "uuid-firmado",
    status: "COMPLETED",
    completedAt: "2026-08-26T18:00:00.000Z",
    lastError: "Error antiguo ya recuperado",
  };

  assert.equal(resolveFirmaSeguroProcessUiState(process), "signed");
  assert.equal(isFirmaSeguroSuccessfulProcess(process), true);
});

test("interpreta tokens completos sin confundir INCOMPLETE con COMPLETE", () => {
  assert.equal(
    isFirmaSeguroSuccessfulProcess({ status: "PROCESS_COMPLETED" }),
    true
  );
  assert.equal(
    isFirmaSeguroSuccessfulProcess({ status: "INCOMPLETE" }),
    false
  );
  assert.equal(
    resolveFirmaSeguroProcessUiState({
      processUuid: "uuid-fallido",
      status: "PROCESS_FAILED",
    }),
    "error"
  );
});

test("conserva el detalle útil y protege secretos o archivos del proveedor", () => {
  const message = formatFirmaSeguroApiFailure(
    {
      error: "<strong>FirmaSeguro rechazó la solicitud</strong>",
      detail: {
        path: "/api/create-full",
        authorization: "Bearer secreto-no-visible",
        payload: {
          message: "El teléfono del firmante es inválido",
          token: "secreto-token",
          errors: {
            telefono: ["Debe contener 10 dígitos"],
            documentBase64: "A".repeat(500),
          },
        },
      },
    },
    "No se pudo enviar el expediente"
  );

  assert.match(message, /FirmaSeguro rechazó la solicitud/);
  assert.match(message, /El teléfono del firmante es inválido/);
  assert.match(message, /Debe contener 10 dígitos/);
  assert.doesNotMatch(message, /<strong>/);
  assert.doesNotMatch(message, /secreto-no-visible|secreto-token/);
  assert.doesNotMatch(message, /create-full|A{50}/);
});

test("el detalle persistido del proceso también se muestra sanitizado", () => {
  const message = formatFirmaSeguroProcessIssue({
    status: "FAILED",
    lastError:
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890; número inválido",
  });

  assert.match(message, /número inválido/);
  assert.match(message, /dato protegido/);
  assert.doesNotMatch(message, /abcdefghijklmnopqrstuvwxyz1234567890/);
});

test("la consola conserva detail, no silencia la reapertura y pinta el error", () => {
  const source = readFileSync(
    new URL(
      "../app/dashboard/creditos/credit-factory-console.tsx",
      import.meta.url
    ),
    "utf8"
  );
  const loadDraftBlock = source.slice(
    source.indexOf("const loadDraft = async"),
    source.indexOf("void loadDraft()")
  );

  assert.match(source, /type FirmaSeguroResponse = \{[\s\S]*detail\?: unknown;/);
  assert.match(source, /formatFirmaSeguroApiFailure\(/);
  assert.match(source, /firmaSeguroProcessFailed/);
  assert.match(source, /Error de firma/);
  assert.match(loadDraftBlock, /firmaSeguroLoadIssue/);
  assert.doesNotMatch(loadDraftBlock, /\.catch\(\(\) => null\)/);
});
