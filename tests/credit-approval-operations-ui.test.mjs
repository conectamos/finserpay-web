import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("detalle operativo se ofrece solo en la sesión nominal de aprobaciones", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  const workspace = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  const sharedPage = read("app/revision-creditos/page.tsx");
  assert.match(page, /allowOperations=\{sharedContext === undefined\}/);
  assert.match(workspace, /view === "operations" && allowOperations/);
  assert.match(sharedPage, /<ApprovalWorkspace shared\s*\/>/);
  assert.doesNotMatch(sharedPage, /allowOperations/);
});

test("la vista distingue el cambio por garantía pendiente de enrolamiento del envío de una nueva firma", () => {
  const ui = read("app/dashboard/aprobaciones/approval-operations.tsx");
  assert.match(ui, /detail\?\.kind === "CREDIT" \? "Solicitar cambio por garantía"/);
  assert.match(ui, /detail\.capabilities\.canConfirmReplacement/);
  assert.match(ui, /"PENDING_ENROLLMENT"/);
  assert.match(ui, /setConfirmation\("imei-confirm"\)/);
  assert.match(ui, /El enrolamiento del nuevo equipo fue aprobado/);
  assert.match(ui, /se regenerará una nueva versión del contrato/);
});

test("la pantalla nunca presenta un fallo técnico de FirmaSeguro como rechazo", () => {
  const ui = read("app/dashboard/aprobaciones/approval-operations.tsx");
  assert.match(ui, /case "TECHNICAL_ERROR": return "Error técnico: requiere revisión"/);
  assert.doesNotMatch(ui, /firma rechazada|Firma rechazada/i);
});
