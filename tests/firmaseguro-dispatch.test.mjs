import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontro ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro ${end}`);
  return source.slice(startIndex, endIndex);
}

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
