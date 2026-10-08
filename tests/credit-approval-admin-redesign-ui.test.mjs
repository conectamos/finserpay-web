import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("la ruta administrativa usa cuentas nominales y reserva SADMIN para el administrador central", () => {
  const page = read("app/dashboard/aprobaciones/page.tsx");
  assert.match(page, /const centralAdmin = canManageApprovalAnalysts\(user\)/);
  assert.match(page, /allowOperations=\{sharedContext === undefined\}/);
  assert.match(page, /canManageSadmin=\{centralAdmin && sharedContext === undefined\}/);
  assert.match(page, /manageLegacySharedAccess=\{centralAdmin && sharedContext === undefined\}/);
  assert.match(page, /Cierra el acceso compartido para continuar con tu cuenta personal/);
  assert.doesNotMatch(page, /manageSharedAccess/);
  assert.doesNotMatch(page, /<ApprovalWorkspace shared\s*\/>/);
  const wrapper = read("app/dashboard/aprobaciones/approval-workspace.tsx");
  assert.match(wrapper, /<ApprovalConsole shared=\{shared\} redesigned=\{redesigned\}/);
  assert.match(wrapper, /onOpenSadmin=\{canManageSadmin \? \(\) => setView\("sadmin"\) : undefined\}/);
  assert.match(wrapper, /<SharedAccessControl retirementMode \/>/);
});

test("la administración de analistas ofrece ingreso por usuario y clave sin enlaces transferibles", () => {
  const accounts = read("app/dashboard/usuarios/approval-analyst-accounts.tsx");
  assert.match(accounts, /Portal \/aliados · Rol Analista de aprobación/);
  assert.match(accounts, /Usuario y clave/);
  assert.doesNotMatch(accounts, /ApprovalAnalystLink|Enlace personal/);
});

test("el acceso compartido anterior solo se ofrece para revocación durante la migración", () => {
  const control = read("app/dashboard/aprobaciones/shared-access-control.tsx");
  assert.match(control, /Los analistas deben ingresar con su cuenta personal/);
  assert.match(control, /Revocar acceso anterior/);
  assert.match(control, /link && retirementMode/);
});

test("el muro comparte tres columnas y conserva identidad, documentos y contacto", () => {
  const workspace = read("app/revision-creditos/shared-approval-workspace.tsx");
  const styles = read("app/revision-creditos/shared-review.module.css");
  assert.match(styles, /grid-template-columns: minmax\(240px,23fr\) minmax\(0,49fr\) minmax\(310px,27fr\)/);
  assert.ok(workspace.includes('props.detail?.id === selectedId'));
  assert.ok(workspace.includes('detail.numeroCreditoSadmin || "PENDIENTE SADMIN"'));
  assert.ok(workspace.includes('detail.clienteDocumento?.replace(/\\D/g, "")'));
  for (const field of ['detail.imei', 'detail.clienteTelefono', 'detail.referenciaEquipo', 'detail.sedeNombre', 'detail.folio', 'detail.scoreLabel', 'detail.fechaCredito']) assert.ok(workspace.includes(field));
  for (const label of ['Evidencias', 'Contrato', 'Historial', 'Ver expediente completo']) assert.ok(workspace.includes(label));
  assert.match(workspace, /Buscar por cliente, cédula, crédito, folio, IMEI o aliado/);
  assert.ok(workspace.includes('detail.clienteDepartamento') && workspace.includes('detail.clienteCiudad') && workspace.includes('detail.clienteDireccion'));
});

test("el flujo compacto explica que guardar envía la novedad al aliado", () => {
  const panel = read("app/dashboard/aprobaciones/approval-novelty-panel.tsx");
  assert.match(panel, /Guardar y enviar al aliado/);
  assert.match(panel, /Confirmar envío al aliado/);
  assert.match(panel, /La novedad aparece en PENDIENTES del aliado/);
});

test("el historial distingue la solución confirmada por el analista", () => {
  const history = read("app/revision-creditos/shared-novelty-history.tsx");
  assert.match(history, /ANALYST_VERIFIED: "Novedad solucionada por el analista"/);
  assert.match(history, /event\.payload\.note/);
  assert.match(history, /event\.payload\.key/);
});
