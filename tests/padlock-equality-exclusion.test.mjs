import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
    "server-only": require.resolve("next/dist/compiled/server-only/empty"),
  },
});
const {
  hasActivePadlockBindingForCredit,
  hasActivePadlockBindingForDeviceIdentifier,
} = await jiti.import("../lib/padlock/equality-exclusion.ts");
const { syncCreditMora } = await jiti.import("../lib/credit-mora-sync.ts");

function assertAppearsBefore(source, before, after) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.notEqual(beforeIndex, -1, `Missing expected source: ${before}`);
  assert.notEqual(afterIndex, -1, `Missing expected source: ${after}`);
  assert.ok(beforeIndex < afterIndex, `${before} must appear before ${after}`);
}

function moraCredit(overrides = {}) {
  return {
    id: 42,
    folio: "FP-0042",
    clienteNombre: "Cliente prueba",
    clienteDocumento: "1000000042",
    clienteTelefono: "3000000042",
    imei: "356938035643809",
    deviceUid: "356938035643809",
    montoCredito: 1_200_000,
    valorCuota: 100_000,
    plazoMeses: 12,
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: new Date("2026-01-05T12:00:00.000Z"),
    fechaProximoPago: new Date("2026-01-05T12:00:00.000Z"),
    estado: "ACTIVO",
    deliverableLabel: null,
    deliverableReady: true,
    equalityState: null,
    equalityService: null,
    equalityPayload: null,
    equalityLastCheckAt: null,
    bloqueoRobo: false,
    bloqueoRoboAt: null,
    bloqueoMora: false,
    bloqueoMoraAt: null,
    pazYSalvoEmitidoAt: null,
    observacionAdmin: null,
    sede: {
      id: 1,
      nombre: "Sede prueba",
    },
    abonos: [],
    ...overrides,
  };
}

function equalityDependencies(bindingActive, counters) {
  return {
    hasActivePadlockBindingForCredit: async () => bindingActive,
    isEqualityConfigured: () => {
      counters.configured += 1;
      return true;
    },
    lockEqualityDevice: async () => {
      counters.lock += 1;
      throw new Error("Equality fixture stop");
    },
    queryEqualityDevices: async () => {
      counters.query += 1;
      throw new Error("Equality query must not run in this fixture");
    },
    unlockEqualityDevice: async () => {
      counters.unlock += 1;
      throw new Error("Equality unlock must not run in this fixture");
    },
  };
}

test("the shared ownership lookup is parameterized and only accepts ACTIVE bindings", async () => {
  const calls = [];
  const active = await hasActivePadlockBindingForCredit(42, {
    async $queryRawUnsafe(query, creditId) {
      calls.push({ query, creditId });
      return [{ exists: true }];
    },
  });

  assert.equal(active, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].creditId, 42);
  assert.match(calls[0].query, /"creditId" = \$1/);
  assert.match(calls[0].query, /"status" = 'ACTIVE'/);
  await assert.rejects(
    () => hasActivePadlockBindingForCredit(0, { $queryRawUnsafe: async () => [] }),
    /PADLOCK_CREDIT_ID_INVALID/
  );
});

test("the device ownership lookup guards only an exact active Padlock IMEI", async () => {
  const calls = [];
  const database = {
    async $queryRawUnsafe(query, deviceIdentifier) {
      calls.push({ query, deviceIdentifier });
      return [{ exists: deviceIdentifier === "356938035643809" }];
    },
  };

  assert.equal(
    await hasActivePadlockBindingForDeviceIdentifier(
      " 356938035643809 ",
      database
    ),
    true
  );
  assert.equal(
    await hasActivePadlockBindingForDeviceIdentifier(
      "ANDROID-DEVICE-UID",
      database
    ),
    false
  );
  assert.equal(
    await hasActivePadlockBindingForDeviceIdentifier(
      "490154203237518",
      database
    ),
    false
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].deviceIdentifier, "356938035643809");
  assert.match(calls[0].query, /"imei" = \$1/);
  assert.match(calls[0].query, /"status" = 'ACTIVE'/);
});

test("an ACTIVE Padlock binding skips mora sync before any Equality call", async () => {
  const counters = { configured: 0, lock: 0, query: 0, unlock: 0 };
  const result = await syncCreditMora(moraCredit({ platform: "IPHONE" }), {
    dependencies: equalityDependencies(true, counters),
    exemptDocuments: new Set(),
    today: new Date("2026-09-03T12:00:00.000Z"),
  });

  assert.equal(result.action, "SKIPPED");
  assert.match(result.message, /Padlock/);
  assert.deepEqual(counters, { configured: 0, lock: 0, query: 0, unlock: 0 });
});

test("Android and unbound iPhone credits retain the legacy Equality path", async () => {
  for (const [id, platform] of [
    [43, "ANDROID"],
    [44, "IPHONE"],
  ]) {
    const counters = { configured: 0, lock: 0, query: 0, unlock: 0 };
    const result = await syncCreditMora(moraCredit({ id, platform }), {
      dependencies: equalityDependencies(false, counters),
      exemptDocuments: new Set(),
      today: new Date("2026-09-03T12:00:00.000Z"),
    });

    assert.equal(result.action, "FAILED");
    assert.equal(counters.configured, 1);
    assert.equal(counters.lock, 1);
    assert.equal(counters.query, 0);
    assert.equal(counters.unlock, 0);
  }
});

test("all legacy Equality entry points enforce Padlock ownership before remote I/O", async () => {
  const [
    moraSource,
    abonosSource,
    queueSource,
    wompiSource,
    commandSource,
    equalityRouteSource,
  ] = await Promise.all([
    readFile(resolve(projectRoot, "lib/credit-mora-sync.ts"), "utf8"),
    readFile(
      resolve(projectRoot, "app/api/creditos/[id]/abonos/route.ts"),
      "utf8"
    ),
    readFile(resolve(projectRoot, "lib/device-unlock-queue.ts"), "utf8"),
    readFile(resolve(projectRoot, "lib/wompi-payment-processing.ts"), "utf8"),
    readFile(
      resolve(projectRoot, "app/api/creditos/[id]/command/route.ts"),
      "utf8"
    ),
    readFile(resolve(projectRoot, "app/api/equality/route.ts"), "utf8"),
  ]);

  const moraFunction = moraSource.slice(
    moraSource.indexOf("export async function syncCreditMora"),
    moraSource.indexOf("export async function syncAllCreditMora")
  );
  assertAppearsBefore(
    moraFunction,
    "hasActivePadlockBindingForCredit(credit.id)",
    "dependencies.lockEqualityDevice"
  );
  assert.match(
    moraSource,
    /padlockDeviceBindings:\s*\{\s*none:\s*\{\s*status:\s*"ACTIVE"/
  );

  const abonosAutomation = abonosSource.slice(
    abonosSource.indexOf("async function syncMoraAutomation"),
    abonosSource.indexOf("export async function GET")
  );
  assertAppearsBefore(
    abonosAutomation,
    "hasActivePadlockBindingForCredit(credit.id)",
    "lockEqualityDevice(credit.deviceUid"
  );

  const queueProcessor = queueSource.slice(
    queueSource.indexOf("export async function processDeviceUnlockCommand"),
    queueSource.indexOf("export async function enqueueUnlockForCurrentCredit")
  );
  assertAppearsBefore(
    queueProcessor,
    "hasActivePadlockBindingForCredit(credit.id)",
    "queryEqualityDevices(deviceUid)"
  );
  assert.match(queueProcessor, /reason:\s*"PADLOCK_ACTIVE_BINDING"/);

  const enqueueCurrent = queueSource.slice(
    queueSource.indexOf("export async function enqueueUnlockForCurrentCredit"),
    queueSource.indexOf("export async function processPendingDeviceUnlockCommands")
  );
  assertAppearsBefore(
    enqueueCurrent,
    "hasActivePadlockBindingForCredit(credit.id)",
    "enqueueDeviceUnlockCommand({"
  );

  const ownershipLookup = wompiSource.indexOf(
    "const padlockControlsDevice = await hasActivePadlockBindingForCredit"
  );
  const paymentTransaction = wompiSource.indexOf(
    "const transactionPromise = prisma.$transaction",
    ownershipLookup
  );
  assert.ok(ownershipLookup >= 0 && ownershipLookup < paymentTransaction);
  assert.match(
    wompiSource,
    /const unlockCommand = shouldUnlock && !padlockControlsDevice/
  );

  const manualGuard = commandSource.indexOf(
    "await hasActivePadlockBindingForCredit(current.id)"
  );
  const commandSwitch = commandSource.indexOf("switch (command)", manualGuard);
  assert.ok(manualGuard >= 0 && manualGuard < commandSwitch);
  assert.match(commandSource, /\{ status: 409 \}/);

  const equalityGet = equalityRouteSource.slice(
    equalityRouteSource.indexOf("export async function GET"),
    equalityRouteSource.indexOf("export async function POST")
  );
  const equalityPost = equalityRouteSource.slice(
    equalityRouteSource.indexOf("export async function POST")
  );
  assertAppearsBefore(
    equalityGet,
    "if (!centralAdmin)",
    "hasActivePadlockBindingForDeviceIdentifier"
  );
  assertAppearsBefore(
    equalityGet,
    "hasActivePadlockBindingForDeviceIdentifier",
    "queryEqualityDevices(deviceUid)"
  );
  assertAppearsBefore(
    equalityPost,
    "validateDraftAccess()",
    "hasActivePadlockBindingForDeviceIdentifier"
  );
  assertAppearsBefore(
    equalityPost,
    "hasActivePadlockBindingForDeviceIdentifier",
    "switch (action)"
  );
  assert.match(equalityRouteSource, /code: "PADLOCK_DEVICE_MANAGED"/);
});
