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
  const route = await readProjectFile(
    "app/api/creditos/borradores/[id]/firma-seguro/route.ts"
  );
  const post = sourceBetween(route, "export async function POST", "\n}");
  const currentLookup = post.indexOf(
    "const current = await getLatestFirmaSeguroProcessForDraft(draftId)"
  );
  const idempotentReturn = post.indexOf(
    "current && canReuseFirmaSeguroProcess(current)"
  );
  const buildCredit = post.indexOf("await buildDraftCredit(authorized.row)");
  const dispatchLock = post.indexOf("tryAcquireFirmaSeguroDraftDispatchLock");
  const lockedLookup = post.indexOf("const lockedCurrent = await");
  const providerDispatch = post.indexOf("createFirmaSeguroProcessForDraft");

  assert.ok(currentLookup >= 0);
  assert.ok(idempotentReturn > currentLookup);
  assert.ok(buildCredit > idempotentReturn);
  assert.ok(dispatchLock > buildCredit);
  assert.ok(lockedLookup > dispatchLock);
  assert.ok(providerDispatch > lockedLookup);
  assert.match(post, /idempotent: true/);
  assert.match(route, /if \(sanitizeText\(process\.lastError\)\) \{/);
  assert.match(route, /isFirmaSeguroCompletedStatus\(normalized\)/);
  assert.match(route, /isFirmaSeguroFailedStatus\(normalized\)/);
  assert.match(route, /FIRMASEGURO_DISPATCH_IN_PROGRESS/);
  assert.match(route, /await dispatchLock\.release\(\)/);
});

test("el bloqueo de despacho usa una sesion dedicada y una llave por borrador", async () => {
  const storage = await readProjectFile("lib/firmaseguro-storage.ts");

  assert.match(storage, /tryAcquireFirmaSeguroDraftDispatchLock/);
  assert.match(storage, /pg_try_advisory_lock/);
  assert.match(storage, /pg_advisory_unlock/);
  assert.match(storage, /new Client\(/);
  assert.doesNotMatch(storage, /pg_advisory_xact_lock/);
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
