import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { buildVeriffRetryPolicy } = await jiti.import(
  "../lib/veriff-retry-policy-core.ts"
);
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

test("la politica Veriff permite exactamente un reintento despues del primer rechazo", () => {
  assert.deepEqual(buildVeriffRetryPolicy(0), {
    applicationRejected: false,
    declinedAttempts: 0,
    maxAttempts: 2,
    remainingAttempts: 2,
    retryAllowed: false,
  });
  assert.deepEqual(buildVeriffRetryPolicy(1), {
    applicationRejected: false,
    declinedAttempts: 1,
    maxAttempts: 2,
    remainingAttempts: 1,
    retryAllowed: true,
  });
  assert.deepEqual(buildVeriffRetryPolicy(2), {
    applicationRejected: true,
    declinedAttempts: 2,
    maxAttempts: 2,
    remainingAttempts: 0,
    retryAllowed: false,
  });
});

test("solo DECLINED consume intentos y el segundo rechazo cierra el borrador", async () => {
  const policy = await readProjectFile("lib/veriff-retry-policy.ts");

  assert.match(policy, /AND "status" = 'DECLINED'/);
  assert.match(policy, /SET "estado" = 'CERRADO'/);
  assert.match(policy, /"closedReason" = 'RECHAZADA'/);
  assert.match(policy, /"creditoId" IS NULL/);
});

test("la API bloquea nuevas sesiones cuando se agotaron los intentos", async () => {
  const route = await readProjectFile("app/api/creditos/veriff/route.ts");
  const policyGuard = route.indexOf("if (retryPolicy.applicationRejected)");
  const providerCall = route.indexOf("await veriffCreateSession({");

  assert.ok(policyGuard >= 0);
  assert.ok(providerCall > policyGuard);
  assert.match(route, /status: 409/);
});

test("la fabrica usa modal real y revela los datos solo despues de aprobar", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );

  assert.match(source, /function IdentityValidationDialog/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /alt="QR para validar la identidad del cliente"/);
  assert.match(source, /Continuar con la venta/);
  assert.match(
    source,
    /const showIdentityClientForm\s*=\s*clienteFormUnlocked\s*&&\s*\(!veriffIdentityFlowEnabled \|\| identityClientDetailsOpen\)/
  );
  assert.match(source, /id="fp-identity-client-details"/);
  assert.match(source, /Telefono aprobado/);
});

test("estado civil y estrato se conservan en el borrador", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );

  assert.match(source, /clienteEstadoCivil,/);
  assert.match(source, /clienteEstrato,/);
  assert.match(source, />\s*Estado civil\s*</);
  assert.match(source, />\s*Estrato\s*</);
});
