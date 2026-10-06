import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("el sidebar del analista expone los ocho módulos bajo Aprobaciones", () => {
  const source = read("app/dashboard/_components/admin-sidebar.tsx");
  const analystNavigation = source.slice(
    source.indexOf("isApprovalAnalystRole(rolUsuario)"),
    source.indexOf("] : [", source.indexOf("isApprovalAnalystRole(rolUsuario)")),
  );

  for (const [href, label] of [
    ["/dashboard/aprobaciones", "Aprobaciones"],
    ["/dashboard/aprobaciones/solicitudes", "Solicitudes"],
    ["/dashboard/aprobaciones/cambio-imei", "Cambio de IMEI"],
    ["/dashboard/aprobaciones/firma-seguro", "Gestionar firma"],
    ["/dashboard/aprobaciones/liberar-consulta", "Liberar consulta"],
    ["/dashboard/aprobaciones/sadmin", "Creación Sadmin"],
    ["/dashboard/aprobaciones/excepciones-mora", "Excepciones de mora"],
    ["/dashboard/aprobaciones/cartera-mora", "Cartera en mora"],
  ]) {
    assert.match(analystNavigation, new RegExp(`href: "${href.replaceAll("/", "\\/")}"[^\n]+label: "${label}"`));
  }
  assert.doesNotMatch(analystNavigation, /label: "Bienvenida"/);
});

test("las subrutas operativas exigen la cuenta nominal del analista", () => {
  const access = read("app/dashboard/aprobaciones/approval-dashboard-access.ts");
  assert.match(access, /getNominalApprovalAnalystSessionUser/);
  assert.match(access, /getApprovalSharedRequestActor/);
  assert.doesNotMatch(access, /getCreditApprovalSessionUser/);

  for (const route of ["solicitudes", "cambio-imei", "firma-seguro", "liberar-consulta", "sadmin"]) {
    assert.match(
      read(`app/dashboard/aprobaciones/${route}/page.tsx`),
      /requireNominalApprovalDashboardAccess\(\)/,
    );
  }
});

test("la mesa del analista conserva el expediente completo y sus accesos operativos", () => {
  const source = read("app/dashboard/aprobaciones/analyst-approval-workspace.tsx");
  assert.match(source, />Aprobaciones</);
  assert.match(source, /Revisa y gestiona las solicitudes de crédito de nuestros aliados\./);
  assert.match(source, /Buscar cédula, crédito o IMEI/);
  for (const column of ["Número", "Cliente", "Cédula", "Aliado", "Equipo", "Monto autorizado", "Estado", "Tiempo", "Acciones"]) {
    assert.match(source, new RegExp(`>${column}<`));
  }
  assert.match(source, /Requiere atención/);
  assert.match(source, /\["IMEI", selectedQueueItem\?\.imei/);
  assert.match(source, /\["Última actualización", displayDate/);
  assert.match(source, /\["Estado Sadmin", selectedQueueItem\?\.sadmin\?\.estadoCreacion/);
  assert.match(source, /\["Número Sadmin", selectedQueueItem\?\.sadmin\?\.numeroCredito/);
  assert.match(source, /<SharedApprovalWorkspace \{\.\.\.props\} onBack=\{\(\) => \{ setFullReview\(false\); props\.onBack\(\); \}\} \/>/);
  assert.match(source, /className="min-h-12 !w-auto min-w-0 flex-1/);
  assert.match(source, /id="analyst-date-filter"/);
  for (const option of ["Todas las fechas", "Hoy", "Últimos 7 días", "Últimos 30 días"]) {
    assert.match(source, new RegExp(`>${option}<`));
  }
  assert.match(source, /item\.status === "APPROVED" \? item\.approvedAt/);
  assert.match(source, /operationHref\("\/dashboard\/aprobaciones\/cambio-imei", props\.detail\)/);
  assert.match(source, /operationHref\("\/dashboard\/aprobaciones\/firma-seguro", props\.detail\)/);
  assert.doesNotMatch(source, /\{props\.(?:callPanel|noveltyPanel|signaturePanel|approvalPanel)\}/);
  assert.match(source, /type="date" value=\{dateFrom\}/);
  assert.match(source, /type="date" value=\{dateTo\}/);
  assert.match(source, /fetch\("\/api\/aprobaciones\/aliados"/);
  assert.match(source, /min-w-\[60rem\]/);
  assert.doesNotMatch(source, /min-w-\[72rem\]/);
});

test("IMEI, firma, solicitudes y TX06 reutilizan los componentes existentes en modo analista", () => {
  const operationRoute = read("app/dashboard/aprobaciones/approval-operation-route.tsx");
  assert.match(operationRoute, /mode=\{preferredPanel\}/);
  assert.match(operationRoute, /preferredPanel=\{preferredPanel\}/);
  assert.match(operationRoute, /initialQuery=\{initialQuery\}/);
  assert.match(operationRoute, /\/dashboard\/aprobaciones\?credito=/);

  const requests = read("app/dashboard/aprobaciones/solicitudes/page.tsx");
  assert.match(requests, /viewerRole="ANALYST"/);
  assert.match(requests, /baseHref="\/dashboard\/aprobaciones\/solicitudes"/);

  const release = read("app/dashboard/aprobaciones/liberar-consulta/page.tsx");
  assert.match(release, /<Tx06ReleaseConsole mode="analyst" \/>/);
});

test("la cola aplica aliado y fechas en servidor antes del cursor", () => {
  const client = read("app/dashboard/aprobaciones/approval-client.ts");
  assert.match(client, /query\.set\("aliado", options\.aliado\.trim\(\)\)/);
  assert.match(client, /query\.set\("desde", options\.desde\.trim\(\)\)/);
  assert.match(client, /query\.set\("hasta", options\.hasta\.trim\(\)\)/);
  assert.ok(client.indexOf('query.set("hasta"') < client.indexOf('query.set("cursor"'));
});

test("el shell neutraliza muted y border solo para el analista", () => {
  const shell = read("app/dashboard/aprobaciones/approval-dashboard-shell.tsx");
  assert.match(shell, /isApprovalAnalystRole\(user\.rolNombre\)/);
  assert.match(shell, /\[--fp-muted:#626660\] \[--fp-border:#dedfdb\]/);
});
