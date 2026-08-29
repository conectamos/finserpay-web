import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { buildVeriffRetryPolicy, veriffDeclineWasCanonicalAtDecision } = await jiti.import(
  "../lib/veriff-retry-policy-core.ts"
);
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

test("la politica Veriff cierra la solicitud con el primer rechazo", () => {
  assert.deepEqual(buildVeriffRetryPolicy(0), {
    applicationRejected: false,
    declinedAttempts: 0,
    maxAttempts: 1,
    remainingAttempts: 1,
    retryAllowed: false,
  });
  assert.deepEqual(buildVeriffRetryPolicy(1), {
    applicationRejected: true,
    declinedAttempts: 1,
    maxAttempts: 1,
    remainingAttempts: 0,
    retryAllowed: false,
  });
  assert.deepEqual(buildVeriffRetryPolicy(2), {
    applicationRejected: true,
    declinedAttempts: 2,
    maxAttempts: 1,
    remainingAttempts: 0,
    retryAllowed: false,
  });
});

test("solo DECLINED consume intentos y el primer rechazo cierra el borrador", async () => {
  const policy = await readProjectFile("lib/veriff-retry-policy.ts");

  assert.match(policy, /AND declined\."status" = 'DECLINED'/);
  assert.match(
    policy,
    /AND NOT EXISTS \([\s\S]*?newer\."id" > declined\."id"[\s\S]*?newer\."createdAt" < COALESCE/
  );
  assert.match(policy, /SET "estado" = 'CERRADO'/);
  assert.match(policy, /"closedReason" = 'RECHAZADA'/);
  assert.match(policy, /"creditoId" IS NULL/);
});

test("la hora de decisión excluye un DECLINED recibido después de crear otro intento", () => {
  const newerAttempt = { id: 2, createdAt: new Date("2026-01-01T10:01:00Z") };

  assert.equal(
    veriffDeclineWasCanonicalAtDecision({
      declinedId: 1,
      decidedAt: new Date("2026-01-01T10:00:00Z"),
      newerAttempts: [newerAttempt],
    }),
    true
  );
  assert.equal(
    veriffDeclineWasCanonicalAtDecision({
      declinedId: 1,
      decidedAt: new Date("2026-01-01T10:02:00Z"),
      newerAttempts: [newerAttempt],
    }),
    false
  );
});

test("la API bloquea nuevas sesiones cuando se agotaron los intentos", async () => {
  const route = await readProjectFile("app/api/creditos/veriff/route.ts");
  const policyGuard = route.indexOf("if (retryPolicy.applicationRejected)");
  const providerCall = route.indexOf("await veriffCreateSession({");

  assert.ok(policyGuard >= 0);
  assert.ok(providerCall > policyGuard);
  assert.match(route, /status: 409/);
});

test("la fabrica usa modal real en el paso 3 y muestra los datos tras DataCrédito", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );

  assert.match(source, /function IdentityValidationDialog/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /alt="QR para validar la identidad del cliente"/);
  assert.match(source, /Continuar con la firma/);
  assert.match(
    source,
    /const clienteFormUnlocked\s*=\s*dataCreditoFlowReady/
  );
  assert.match(source, /const showIdentityClientForm\s*=\s*clienteFormUnlocked/);
  assert.match(source, />\s*Información del cliente\s*</);
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
