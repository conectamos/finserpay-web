import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("la ruta administrativa activa el muro rediseñado sin convertir su sesión en acceso compartido", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  assert.match(page, /<ApprovalConsole redesigned\s*\/>/);
  assert.doesNotMatch(page, /<ApprovalConsole shared\s*\/>/);
});

test("cada fila muestra la cédula disponible y conserva un estado explícito cuando falta", () => {
  const workspace = read("app/revision-creditos/shared-approval-workspace.tsx");
  assert.match(workspace, /Cédula:\s*\{item\.clienteDocumento\?\.trim\(\)\s*\|\|\s*"No disponible"\}/);
  assert.match(workspace, /item\.folio/);
  assert.match(workspace, /item\.aliadoNombre/);
});

test("el flujo compacto explica que guardar envía la novedad al aliado", () => {
  const panel = read("app/dashboard/aprobaciones/approval-novelty-panel.tsx");
  assert.match(panel, /Guardar y enviar al aliado/);
  assert.match(panel, /Confirmar envío al aliado/);
  assert.match(panel, /La novedad aparece en PENDIENTES del aliado/);
});
