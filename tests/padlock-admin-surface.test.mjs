import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return readFile(new URL(path, `file:///${root.replaceAll("\\", "/")}/`), "utf8");
}

test("la página Padlock exige acceso de administrador central y reutiliza el shell", async () => {
  const page = await source("app/dashboard/integraciones/padlock/page.tsx");
  const sidebar = await source("app/dashboard/_components/admin-sidebar.tsx");

  assert.match(page, /requireCentralAdminDashboardAccess\(\)/);
  assert.match(page, /<AppShell/);
  assert.match(page, /<AdminSidebar/);
  assert.match(page, /<AdminWorkspaceTopbar/);
  assert.match(page, /<PageHeader/);
  assert.match(sidebar, /\/dashboard\/integraciones\/padlock/);
});

test("cada Route Handler aplica autorización central y las mutaciones agregan defensas", async () => {
  const routePaths = [
    "app/api/padlock/route.ts",
    "app/api/padlock/policies/route.ts",
    "app/api/padlock/bindings/route.ts",
    "app/api/padlock/commands/route.ts",
  ];
  const routes = await Promise.all(routePaths.map(source));

  for (const route of routes) {
    assert.match(route, /requirePadlockCentralAdmin\(\)/);
    assert.doesNotMatch(route, /lockPadlockDevice|unlockPadlockDevice|queryPadlockDeviceByImei/);
  }

  for (const route of routes.slice(1)) {
    assert.match(route, /requirePadlockSameOrigin\(request\)/);
    assert.match(route, /consumePadlockAdminRateLimit/);
    assert.match(route, /readPadlockAdminJson\(request\)/);
  }
});

test("la consola confirma comandos manuales, exige motivo y solo muestra IMEI enmascarado", async () => {
  const ui = await source(
    "app/dashboard/integraciones/padlock/padlock-admin-console.tsx"
  );

  assert.match(ui, /<ConfirmDialog/);
  assert.match(ui, /manualReason\.trim\(\)\.length < 10/);
  assert.match(ui, /imeiMasked/);
  assert.doesNotMatch(ui, /binding\.imei(?!Masked)/);
  assert.match(ui, /"Pendiente"/);
  assert.match(ui, /"Procesando"/);
  assert.match(ui, /"Bloqueado"/);
  assert.match(ui, /"Desbloqueado"/);
  assert.match(ui, /"Requiere revisión"/);
  assert.match(ui, /PADLOCK_INTEGRATION_ENABLED/);
  assert.match(ui, /Días 5 y 20/);
  assert.match(ui, /America\/Bogota/);
});

test("la consola confirma políticas y vinculaciones con un resumen seguro antes de mutar", async () => {
  const ui = await source(
    "app/dashboard/integraciones/padlock/padlock-admin-console.tsx"
  );

  assert.match(ui, /setPendingPolicy\(\{/);
  assert.match(ui, /if \(!pendingPolicy\) return;/);
  assert.match(ui, /Alcance:/);
  assert.match(ui, /Gracia:/);
  assert.match(ui, /Bloqueo desde:/);
  assert.match(ui, /Desbloqueo:/);
  assert.match(ui, /setPendingBinding\(\{/);
  assert.match(ui, /if \(!pendingBinding\) return;/);
  assert.match(ui, /Padlock asumirá la gestión remota/);
  assert.match(ui, /pendingBinding\.imei\.slice\(-4\)/);
  assert.doesNotMatch(ui, /\$\{pendingBinding\.imei\}(?!\.slice)/);
  assert.equal((ui.match(/<ConfirmDialog/g) || []).length, 3);
});

test("el servicio valida crédito iPhone, allowlist y coincidencia exacta antes del binding", async () => {
  const service = await source("lib/padlock/admin-service.ts");

  assert.match(service, /platform !== "IPHONE"/);
  assert.match(service, /credit\.imei[\s\S]*!== input\.imei/);
  assert.match(service, /bloqueoRobo: true/);
  assert.match(service, /bloqueoMora: true/);
  assert.match(service, /PADLOCK_ROBBERY_LOCK_REQUIRES_REVIEW/);
  assert.match(service, /PADLOCK_EXISTING_MORA_LOCK_REQUIRES_REVIEW/);
  assert.ok(
    service.indexOf("if (credit.bloqueoRobo)") <
      service.indexOf("assertProviderCallsAllowed();")
  );
  assert.ok(
    service.indexOf("if (credit.bloqueoMora)") <
      service.indexOf("assertProviderCallsAllowed();")
  );
  assert.match(service, /isPadlockSandboxCreditAllowed/);
  assert.match(service, /queryPadlockDeviceByImei/);
  assert.match(service, /bindPadlockIphoneDevice/);
  assert.match(service, /assertProviderCallsAllowed\(\)/);
  assert.match(service, /runtime\.environment !== "production"/);
  assert.match(service, /runtime\.productionAllowed/);
  assert.match(service, /device\.status === "locked"/);
  assert.match(service, /PADLOCK_PREEXISTING_LOCK_REQUIRES_REVIEW/);
  assert.match(service, /device\.status !== "unlocked"/);
  assert.match(service, /initialProviderState: "UNLOCKED"/);
  assert.match(service, /imeiMasked/);
});

test("el binding conserva como línea base el unlocked verificado", async () => {
  const storage = await source("lib/padlock/storage.ts");

  assert.match(storage, /initialProviderState: "UNLOCKED"/);
  assert.match(storage, /PADLOCK_INITIAL_STATE_INVALID/);
  assert.match(
    storage,
    /"confirmedState", "lastProviderState",[^]*"lastConfirmedAt"/
  );
  assert.match(
    storage,
    /'UNLOCKED', 0, 'UNLOCKED', 'UNLOCKED',[^]*CURRENT_TIMESTAMP/
  );
});

test("los comandos manuales vuelven a validar binding y allowlists antes de entrar a la cola", async () => {
  const service = await source("lib/padlock/admin-service.ts");
  const route = await source("app/api/padlock/commands/route.ts");

  assert.match(service, /loadPadlockEvaluationContext\(creditId\)/);
  assert.match(service, /context\.binding\.id !== input\.bindingId/);
  assert.match(service, /isPadlockSandboxCreditAllowed\(config, String\(creditId\)\)/);
  assert.match(service, /assertPadlockSandboxDeviceAllowed/);
  assert.match(route, /reason\.length < 10/);
});

test("la protección same-origin compara protocolo y host", async () => {
  const http = await source("lib/padlock/admin-http.ts");

  assert.match(http, /x-forwarded-proto/);
  assert.match(http, /originUrl\.protocol[\s\S]*requestProtocol/);
  assert.match(http, /originUrl\.host[\s\S]*requestHost/);
});

test("el rate limit administrativo separa políticas, vínculos y comandos", async () => {
  const { consumePadlockAdminRateLimit } = await import(
    "../lib/padlock/admin-rate-limit.ts"
  );
  const baseActor = 9_010_001;

  for (let index = 0; index < 10; index += 1) {
    assert.equal(
      consumePadlockAdminRateLimit({
        actorUserId: baseActor,
        mutation: "command",
        now: 10_000,
      }).allowed,
      true
    );
  }
  const blocked = consumePadlockAdminRateLimit({
    actorUserId: baseActor,
    mutation: "command",
    now: 10_000,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.headers["Retry-After"], "60");

  assert.equal(
    consumePadlockAdminRateLimit({
      actorUserId: baseActor,
      mutation: "policy",
      now: 10_000,
    }).allowed,
    true
  );
});

test("el resumen admin usa agregados totales y el último comando de cada binding visible", async () => {
  const service = await source("lib/padlock/admin-service.ts");
  const ui = await source(
    "app/dashboard/integraciones/padlock/padlock-admin-console.tsx"
  );

  assert.match(service, /WITH latest_actionable AS/);
  assert.match(service, /COUNT\(\*\)::integer AS "count"/);
  assert.match(service, /command\."bindingId" = ANY\(\$1::uuid\[\]\)/);
  assert.match(service, /listLatestActionableCommandsForBindings/);
  assert.doesNotMatch(service, /bindings\.filter\(\(item\) => item\.status/);
  assert.match(service, /limit: ADMIN_BINDING_LIMIT/);
  assert.match(service, /total: statusSummary\.total/);
  assert.match(service, /limit: ADMIN_COMMAND_LIMIT/);
  assert.match(ui, /bindingList\.shown/);
  assert.match(ui, /bindingList\.total/);
  assert.match(ui, /commandList\.shown/);
  assert.match(ui, /commandList\.total/);
  assert.match(ui, /actualizados más recientemente/);
  assert.match(ui, /creados más recientemente/);
});

test("la consola prioriza revisiones financieras y muestra diagnósticos seguros", async () => {
  const service = await source("lib/padlock/admin-service.ts");
  const ui = await source(
    "app/dashboard/integraciones/padlock/padlock-admin-console.tsx"
  );

  assert.match(service, /decidePadlockAction\(\{/);
  assert.match(service, /trigger: "RECONCILIATION"/);
  assert.match(service, /decision\.requiresReview === true/);
  assert.match(service, /const status: UiStatus = reviewReason/);
  assert.match(service, /errorCode: command\.lastErrorCode \|\| null/);
  assert.match(service, /providerState: command\.lastProviderState \|\| null/);
  assert.match(ui, /binding\.reviewReason/);
  assert.match(ui, /command\.errorCode/);
  assert.match(ui, /providerStateLabel\(command\.providerState\)/);
  assert.match(ui, /Evaluación financiera/);
  assert.doesNotMatch(ui, /AUTO_PAYMENT|Pago confirmado/);
});

test("el agregado de estados conserva totales fuera de la ventana visible", async () => {
  const { buildPadlockAdminStatusSummary } = await import(
    "../lib/padlock/admin-summary.ts"
  );
  const summary = buildPadlockAdminStatusSummary([
    { status: "PENDING", count: 120 },
    { status: "PROCESSING", count: 3n },
    { status: "LOCKED", count: "8" },
    { status: "UNLOCKED", count: 21 },
    { status: "ERROR", count: 2 },
    { status: "NOT_ENROLLED", count: 4 },
    { status: "REVIEW_REQUIRED", count: 5 },
    { status: "UNKNOWN", count: 7 },
  ]);

  assert.deepEqual(summary.counters, {
    pending: 120,
    processing: 3,
    locked: 8,
    unlocked: 21,
    error: 2,
    reviewRequired: 9,
  });
  assert.equal(summary.total, 170);
});

test("la redacción de texto libre cubre secretos etiquetados, JSON, JWT e IMEI", async () => {
  const { redactPadlockSensitiveText } = await import(
    "../lib/padlock/redaction.ts"
  );
  const redacted = redactPadlockSensitiveText(
    [
      '{"token":"fixture-json-token"}',
      "password=fixture password with spaces",
      "Authorization: Bearer fixture-bearer-token",
      "eyJfixtureHeader.eyJfixturePayload.fixtureSignature",
      "IMEI 356789012345678",
    ].join("\n")
  );

  assert.doesNotMatch(redacted, /fixture-json-token/);
  assert.doesNotMatch(redacted, /fixture password with spaces/);
  assert.doesNotMatch(redacted, /fixture-bearer-token/);
  assert.doesNotMatch(redacted, /eyJfixtureHeader/);
  assert.doesNotMatch(redacted, /356789012345678/);
  assert.match(redacted, /\[REDACTED_DEVICE\]/);
  assert.match(redacted, /\[REDACTED\]/);
});
