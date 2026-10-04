import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontro ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro ${end}`);
  return source.slice(startIndex, endIndex);
}

async function loadSolicitudLockFunctions(Client, connectionString = "fixture") {
  const source = await readProjectFile("lib/firmaseguro-storage.ts");
  const mutationLocks = sourceBetween(
    source,
    "export const SOLICITUD_OPERATION_LOCK_NAMESPACE",
    "function jsonValue"
  );
  const sessionStart = [
    "async function tryAcquireSolicitudSessionLock",
    "export async function tryAcquireSolicitudOperationLock",
  ].map((marker) => source.indexOf(marker)).filter((index) => index >= 0);
  assert.ok(sessionStart.length > 0, "No se encontraron los locks de sesión");
  const sessionEnd = source.indexOf("export async function getFirmaSeguroProcessByUuid", Math.min(...sessionStart));
  assert.ok(sessionEnd > Math.min(...sessionStart));
  const sessionLocks = source.slice(Math.min(...sessionStart), sessionEnd);
  const executable = stripTypeScriptTypes(
    `${mutationLocks}\n${sessionLocks}`.replace(/^export /gm, "")
  );
  return runInNewContext(executable + `\n({
    lockSolicitudOperationMutation,
    tryAcquireSolicitudOperationLock,
    tryAcquireFirmaSeguroDraftDispatchLock,
  });`, {
    Client,
    console,
    process: { env: { DATABASE_URL: connectionString } },
  });
}

// Model PostgreSQL ownership: session and transaction advisory locks share keys,
// and another connection cannot acquire a key until its owner releases it.
function advisoryLockFixture() {
  const owners = new Map();
  const clients = [];
  class Client {
    constructor() {
      this.ended = false;
      this.endCalls = 0;
      clients.push(this);
    }
    async connect() {}
    async query(sql, values) {
      assert.equal(this.ended, false, "No se debe usar una conexión cerrada");
      const key = values.join(":");
      const owner = owners.get(key);
      if (sql.includes("pg_try_advisory_lock")) {
        const acquired = !owner || owner === this;
        if (acquired) owners.set(key, this);
        return { rows: [{ acquired }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        assert.equal(owner, this, "Solo el dueño puede liberar el lock");
        owners.delete(key);
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      assert.match(sql, /pg_advisory_xact_lock/);
      if (owner && owner !== this) throw new Error("advisory lock blocked by another session");
      owners.set(key, this);
      return { rows: [{ locked: 1 }] };
    }
    async end() {
      this.endCalls++;
      this.ended = true;
      for (const [key, owner] of owners) {
        if (owner === this) owners.delete(key);
      }
    }
  }
  return { Client, owners, clients };
}

function transactionAdapter(client) {
  return {
    $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
  };
}

test("el envío admite UUID generados y explícitos y rechaza formatos inválidos", async () => {
  const source = await readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts");
  const core = sourceBetween(source, "async function requestDraftSignatureCore", "export async function POST");
  const reachedLedger = new Error("reached ledger");
  let observedKey;
  const requestSignature = runInNewContext(
    stripTypeScriptTypes(core) + "\nrequestDraftSignatureCore;",
    {
      randomUUID,
      NextResponse: Response,
      getDraftDispatch: async (key) => {
        observedKey = key;
        throw reachedLedger;
      },
    }
  );
  const send = (body) => requestSignature(1, {}, { id: 7, nombre: "Prueba" }, body, "commercial");
  await assert.rejects(send({}), (error) => error === reachedLedger);
  assert.equal(observedKey.length, 36);
  for (const key of [randomUUID(), randomUUID().toUpperCase()]) {
    await assert.rejects(send({ idempotencyKey: key }), (error) => error === reachedLedger);
    assert.equal(observedKey, key);
  }
  for (const key of ["", "invalid", "550e8400-e29b-41d4-a446655440000", "550e8400-e29b-41d4-7716-446655440000"]) {
    observedKey = undefined;
    const response = await send({ idempotencyKey: key });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "DRAFT_DISPATCH_ID_INVALID");
    assert.equal(observedKey, undefined);
  }
});

test("POST convierte un rechazo asíncrono del envío en la respuesta de error", async () => {
  const source = await readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts");
  const post = sourceBetween(source, "export async function POST", "/** Shared business path")
    .replace("export async function POST", "async function POST");
  const failure = new Error("La validación del crédito falló");
  let loggedError;
  const handler = runInNewContext(stripTypeScriptTypes(post) + "\nPOST;", {
    parseDraftId: Number,
    NextResponse: Response,
    readAuthorizedDraft: async () => ({ ok: true, row: {}, centralAdmin: false }),
    getSessionUser: async () => ({ id: 7, nombre: "Prueba" }),
    requestDraftSignatureCore: async () => { throw failure; },
    documentBlacklistErrorResponse: () => null,
    logFirmaSeguroDraftError: (_operation, _id, error) => { loggedError = error; },
    firmaSeguroErrorResponse: (error) => {
      assert.equal(error, failure);
      return Response.json({ ok: false, error: error.message }, { status: 409 });
    },
  });
  const response = await handler(
    new Request("https://example.test/firma-seguro", { method: "POST" }),
    { params: Promise.resolve({ id: "1" }) }
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: failure.message });
  assert.equal(loggedError, failure);
});

test("FirmaSeguro separa el canal de firma de los canales de notificacion", async () => {
  const source = await readProjectFile("lib/firmaseguro-credit.ts");
  const companyPayload = sourceBetween(
    source,
    "function buildCreateFullByCompanyPayload",
    "function buildCreateFullPayload"
  );
  const defaultPayload = sourceBetween(
    source,
    "function buildCreateFullPayload",
    "function mergeFirmaSeguroSnapshot"
  );

  for (const payload of [companyPayload, defaultPayload]) {
    assert.match(payload, /isSendByEmail: delivery\.sendByEmail/);
    assert.match(payload, /isSendByWhatsApp: delivery\.sendByWhatsApp/);
    assert.doesNotMatch(payload, /isSendByEmail: delivery\.notifyByEmail/);
    assert.doesNotMatch(payload, /isSendByWhatsApp: delivery\.notifyByWhatsApp/);
  }
});

test("el reenvio reutiliza un proceso activo antes de construir otro expediente", async () => {
  const [route, ledger] = await Promise.all([
    readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
    readProjectFile("lib/firmaseguro-draft-dispatch-ledger.ts"),
  ]);
  const core = sourceBetween(route, "async function requestDraftSignatureCore", "export async function POST");
  const replayLookup = core.indexOf("const replay = await getDraftDispatch(key)");
  const currentLookup = core.indexOf(
    "const current = await getLatestFirmaSeguroProcessForDraft(draftId)"
  );
  const idempotentReturn = core.indexOf(
    "canReuseFirmaSeguroProcess(current)"
  );
  const dispatchLock = core.indexOf("tryAcquireFirmaSeguroDraftDispatchLock");
  const lockedLookup = core.indexOf("const lockedCurrent = await");
  const buildCredit = core.indexOf(
    "await buildDraftCredit(lockedAuthorized.row)"
  );
  const reserve = core.indexOf("await reserveDraftDispatch(");
  const providerDispatch = core.indexOf("await dispatchReservedDraft(reserved.id)");

  assert.ok(replayLookup >= 0);
  assert.ok(currentLookup > replayLookup);
  assert.ok(idempotentReturn > currentLookup);
  assert.ok(dispatchLock > idempotentReturn);
  assert.ok(lockedLookup > dispatchLock);
  assert.ok(buildCredit > lockedLookup);
  assert.ok(reserve > buildCredit);
  assert.ok(providerDispatch > reserve);
  assert.match(core, /idempotent: true/);
  assert.match(ledger, /"payload"=\$3::jsonb RETURNING "id"/);
  assert.match(ledger, /"status"='DISPATCHING'[\s\S]*"status"='PREPARING' RETURNING/);
  assert.match(ledger, /const acknowledged = await prepared\.sendOnce\(\)/);
  assert.match(route, /if \(sanitizeText\(process\.lastError\)\) \{/);
  assert.match(route, /isFirmaSeguroCompletedStatus\(normalized\)/);
  assert.match(route, /isFirmaSeguroFailedStatus\(normalized\)/);
  assert.match(route, /FIRMASEGURO_DISPATCH_IN_PROGRESS/);
  assert.match(core, /await dispatchLock\.release\(\)/);
});

test("el bloqueo de despacho usa una sesion dedicada y una llave por borrador", async () => {
  const storage = await readProjectFile("lib/firmaseguro-storage.ts");

  assert.match(storage, /tryAcquireFirmaSeguroDraftDispatchLock/);
  assert.match(storage, /pg_try_advisory_lock/);
  assert.match(storage, /pg_advisory_unlock/);
  assert.match(storage, /new Client\(/);
  assert.match(storage, /lockFirmaSeguroDraftMutation/);
  assert.match(storage, /pg_advisory_xact_lock/);
  assert.match(
    storage,
    /SELECT 1::integer AS "locked"[\s\S]{0,100}FROM pg_advisory_xact_lock/
  );
  assert.match(storage, /FIRMASEGURO_DRAFT_LOCK_NAMESPACE/);
});

test("despacho y transacción avanzan sin bloquearse y conservan exclusión por solicitud", async () => {
  const fixture = advisoryLockFixture();
  const locks = await loadSolicitudLockFunctions(fixture.Client);
  const held = [];
  const transaction = new fixture.Client();
  const blockedTransaction = new fixture.Client();
  try {
    const dispatch = await locks.tryAcquireFirmaSeguroDraftDispatchLock(41);
    assert.ok(dispatch);
    held.push(dispatch);
    await locks.lockSolicitudOperationMutation(transactionAdapter(transaction), 41);

    assert.equal(await locks.tryAcquireFirmaSeguroDraftDispatchLock(41), null);
    const otherDraft = await locks.tryAcquireFirmaSeguroDraftDispatchLock(42);
    assert.ok(otherDraft);
    held.push(otherDraft);
    assert.equal(await locks.tryAcquireSolicitudOperationLock(41), null);

    await transaction.end();
    const operation = await locks.tryAcquireSolicitudOperationLock(41);
    assert.ok(operation);
    held.push(operation);
    await assert.rejects(
      locks.lockSolicitudOperationMutation(transactionAdapter(blockedTransaction), 41),
      /advisory lock blocked by another session/
    );
    await operation.release();
    await operation.release();
    await locks.lockSolicitudOperationMutation(transactionAdapter(blockedTransaction), 41);

    await dispatch.release();
    await dispatch.release();
    const reacquired = await locks.tryAcquireFirmaSeguroDraftDispatchLock(41);
    assert.ok(reacquired);
    held.push(reacquired);
  } finally {
    for (const lock of held) await lock.release();
    for (const client of fixture.clients) {
      if (!client.ended) await client.end();
      assert.equal(client.endCalls, 1, "Cada conexión debe cerrarse una sola vez");
    }
  }
  assert.equal(fixture.owners.size, 0);
});

test("PostgreSQL permite reservar bajo el lock de despacho y mantiene los locks de operación", {
  skip: !process.env.FIRMASEGURO_LOCK_TEST_DATABASE_URL,
  timeout: 15_000,
}, async () => {
  const { Client } = await import("pg");
  const connectionString = process.env.FIRMASEGURO_LOCK_TEST_DATABASE_URL;
  const locks = await loadSolicitudLockFunctions(Client, connectionString);
  const draftId = 1_000_000_000 + Number.parseInt(randomUUID().slice(0, 7), 16);
  const transaction = new Client({ connectionString, connectionTimeoutMillis: 3000 });
  const held = [];
  try {
    await transaction.connect();
    const dispatch = await locks.tryAcquireFirmaSeguroDraftDispatchLock(draftId);
    assert.ok(dispatch);
    held.push(dispatch);
    await transaction.query("BEGIN");
    await transaction.query("SET LOCAL statement_timeout = '1000ms'");
    await locks.lockSolicitudOperationMutation(transactionAdapter(transaction), draftId);

    assert.equal(await locks.tryAcquireFirmaSeguroDraftDispatchLock(draftId), null);
    const otherDraft = await locks.tryAcquireFirmaSeguroDraftDispatchLock(draftId + 1);
    assert.ok(otherDraft);
    held.push(otherDraft);
    assert.equal(await locks.tryAcquireSolicitudOperationLock(draftId), null);
    await transaction.query("ROLLBACK");

    const operation = await locks.tryAcquireSolicitudOperationLock(draftId);
    assert.ok(operation);
    held.push(operation);
    await transaction.query("BEGIN");
    await transaction.query("SET LOCAL statement_timeout = '1000ms'");
    await assert.rejects(
      locks.lockSolicitudOperationMutation(transactionAdapter(transaction), draftId),
      (error) => error.code === "57014"
    );
    await transaction.query("ROLLBACK");
    await operation.release();
    await operation.release();

    await transaction.query("BEGIN");
    await transaction.query("SET LOCAL statement_timeout = '1000ms'");
    await locks.lockSolicitudOperationMutation(transactionAdapter(transaction), draftId);
    await transaction.query("ROLLBACK");
    await dispatch.release();
    await dispatch.release();
    const reacquired = await locks.tryAcquireFirmaSeguroDraftDispatchLock(draftId);
    assert.ok(reacquired);
    held.push(reacquired);
  } finally {
    await transaction.query("ROLLBACK").catch(() => undefined);
    await transaction.end().catch(() => undefined);
    for (const lock of held) await lock.release();
  }
});

test("los errores previos al proveedor incluyen codigo y etapa trazables", async () => {
  const route = await readProjectFile(
    "app/api/creditos/borradores/[id]/firma-seguro/route.ts"
  );

  assert.match(route, /code: error\.code/);
  assert.match(route, /stage: "credit_validation"/);
  assert.match(route, /"DATACREDITO_ASSESSMENT_INVALID"/);
  assert.match(route, /stage: "provider_dispatch"/);
  assert.match(route, /ERROR FIRMASEGURO BORRADOR/);
});

test("FirmaSeguro conserva el histórico al reservar un reemplazo", async () => {
  const [route, storage, ledger, frozen] = await Promise.all([
    readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
    readProjectFile("lib/firmaseguro-storage.ts"),
    readProjectFile("lib/firmaseguro-draft-dispatch-ledger.ts"),
    readProjectFile("lib/firmaseguro-draft-frozen.ts"),
  ]);
  const core = sourceBetween(route, "async function requestDraftSignatureCore", "export async function POST");
  const supersedeHistory = sourceBetween(
    storage,
    "export async function markFirmaSeguroDraftProcessesSuperseded",
    "export async function updateFirmaSeguroProcess"
  );

  assert.match(route, /function getDraftFirstPaymentDateState/);
  assert.match(route, /function serializeDraftFirmaSeguroProcess/);
  assert.match(route, /resolveActivationFirstPaymentDate\(/);
  assert.match(core, /getDraftFirstPaymentDateState\(/);
  assert.match(
    core,
    /currentFirstPaymentState[\s\S]{0,300}!currentFirstPaymentState\.requiresFirstPaymentDateReissue/
  );
  assert.match(core, /fechaPrimerPago:\s*firstPaymentDateKey/);
  assert.match(frozen, /FIRMASEGURO_FIRST_PAYMENT_DATE_CHANGED/);
  assert.match(ledger, /markFirmaSeguroDraftProcessesSuperseded\(db/);
  assert.ok(ledger.indexOf("markFirmaSeguroDraftProcessesSuperseded(db") <
    ledger.indexOf('INSERT INTO "FirmaSeguroDraftDispatch"'));

  assert.match(supersedeHistory, /UPDATE "FirmaSeguroProcess"/);
  assert.match(supersedeHistory, /SET "supersededAt" = CURRENT_TIMESTAMP/);
  assert.match(supersedeHistory, /"supersededReason" = \$3/);
  assert.doesNotMatch(supersedeHistory, /DELETE FROM/);
  assert.doesNotMatch(supersedeHistory, /"signedDocumentBase64"\s*=/);
});


test("la consola invalida una firma al cruzar el corte del calendario", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const sync = sourceBetween(
    source,
    "const syncFirstPaymentDate = () =>",
    "const saldoBaseFinanciado"
  );

  assert.doesNotMatch(sync, /if \(firmaSeguroDraftProcess\) return/);
  assert.match(sync, /setFirmaSeguroDraftProcess\(\(current\) =>/);
  assert.match(
    sync,
    /current\.firstPaymentDate !== canonicalFirstPaymentDate/
  );
  assert.match(sync, /window\.setInterval\(syncFirstPaymentDate, 60_000\)/);
  assert.match(sync, /window\.addEventListener\("focus", syncFirstPaymentDate\)/);
  assert.match(sync, /document\.addEventListener\("visibilitychange", syncWhenVisible\)/);
});
