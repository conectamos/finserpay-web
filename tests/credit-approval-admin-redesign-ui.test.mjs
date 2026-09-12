import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("la ruta administrativa activa el muro rediseñado sin convertir su sesión en acceso compartido", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  assert.match(page, /<ApprovalConsole redesigned\s*\/>/);
  assert.doesNotMatch(page, /<ApprovalConsole shared\s*\/>/);
});

test("el muro administrativo y el enlace usan el scroll normal de la página", () => {
  const styles = read("app/revision-creditos/shared-review.module.css");
  assert.match(styles, /\.root \{ min-height: 100dvh; overflow: visible; \}/);
  assert.match(styles, /\.listScroll \{ max-height: none; \}/);
  assert.match(styles, /overscroll-behavior: auto/);
});

test("cada fila muestra la cédula disponible y conserva un estado explícito cuando falta", () => {
  const workspace = read("app/revision-creditos/shared-approval-workspace.tsx");
  assert.match(workspace, /Cédula:\s*\{item\.clienteDocumento\?\.trim\(\)\s*\|\|\s*"No disponible"\}/);
  assert.match(workspace, /item\.folio/);
  assert.match(workspace, /item\.aliadoNombre/);
});

test("el buscador compartido anuncia la cédula en su etiqueta, ayuda y estado vacío", () => {
  const workspace = read("app/revision-creditos/shared-approval-workspace.tsx");
  assert.match(workspace, /Buscar por cliente, cédula, folio o aliado/);
  assert.match(workspace, /placeholder="Cliente, cédula, folio o aliado"/);
  assert.match(workspace, /Prueba con otro cliente, cédula, folio o aliado\./);
});

test("la ficha muestra la referencia del equipo y contempla el dato ausente", () => {
  const workspace = read("app/revision-creditos/shared-approval-workspace.tsx");
  assert.match(workspace, /Referencia del equipo/);
  assert.match(workspace, /detail\.referenciaEquipo\?\.trim\(\) \|\| "No disponible"/);
});

test("datos del cliente muestra departamento, ciudad y dirección en el render compartido por administrador y enlace", () => {
  const workspace = read("app/revision-creditos/shared-approval-workspace.tsx");
  const console = read("app/dashboard/aprobaciones/approval-console.tsx");
  const sharedPage = read("app/revision-creditos/page.tsx");
  assert.match(workspace, /\["Departamento", detail\.clienteDepartamento\], \["Ciudad", detail\.clienteCiudad\], \["Dirección", detail\.clienteDireccion\]/);
  assert.match(workspace, /styles\.customerAddress/);
  assert.match(console, /return <SharedApprovalWorkspace/);
  assert.match(sharedPage, /<ApprovalConsole shared\s*\/>/);
});

test("el flujo compacto explica que guardar envía la novedad al aliado", () => {
  const panel = read("app/dashboard/aprobaciones/approval-novelty-panel.tsx");
  assert.match(panel, /Guardar y enviar al aliado/);
  assert.match(panel, /Confirmar envío al aliado/);
  assert.match(panel, /La novedad aparece en PENDIENTES del aliado/);
});
