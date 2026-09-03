import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  canOperateSolicitud,
  canSellerOperateSolicitud,
  isDirectSalesProfile,
} = await jiti.import("../lib/solicitud-operation-access.ts");
const {
  canRecoverAssessmentIdentityMismatch,
  resolveMissingAssessmentGateView,
} = await jiti.import(
  "../lib/datacredito/resume-gate.ts"
);

const owner = { vendedorId: 80, aliadoId: 12 };
const seller = { id: 80, tipoPerfil: "VENDEDOR", sedeId: 900 };

test("la operacion depende del perfil comercial titular y aliado, nunca de la sede activa", () => {
  assert.equal(isDirectSalesProfile("VENDEDOR"), true);
  assert.equal(isDirectSalesProfile("SUPERVISOR"), true);
  assert.equal(isDirectSalesProfile("ADMIN"), false);
  assert.equal(isDirectSalesProfile(null), false);
  assert.equal(canSellerOperateSolicitud(seller, 12, owner), true);
  assert.equal(
    canSellerOperateSolicitud({ ...seller, sedeId: 901 }, 12, owner),
    true,
    "cambiar de sede dentro del aliado no cambia al titular"
  );
  assert.equal(canSellerOperateSolicitud({ ...seller, id: 81 }, 12, owner), false);
  assert.equal(canSellerOperateSolicitud(seller, 13, owner), false);
  assert.equal(
    canSellerOperateSolicitud({ ...seller, tipoPerfil: "SUPERVISOR" }, 12, owner),
    true,
    "el supervisor puede operar la venta que creo con su propio perfil"
  );
  assert.equal(
    canSellerOperateSolicitud(
      { ...seller, id: 81, tipoPerfil: "SUPERVISOR" },
      12,
      owner
    ),
    false,
    "un supervisor no puede operar la venta de otro perfil"
  );
  assert.equal(
    canSellerOperateSolicitud(
      { ...seller, tipoPerfil: "SUPERVISOR" },
      13,
      owner
    ),
    false,
    "un supervisor titular no puede cruzar aliados"
  );
  assert.equal(canSellerOperateSolicitud(null, 12, owner), false);
  assert.equal(canSellerOperateSolicitud(seller, null, owner), false);
  assert.equal(
    canOperateSolicitud({
      central: true,
      seller: null,
      viewerAllyId: null,
      owner,
    }),
    true
  );
  assert.equal(
    canOperateSolicitud({
      central: true,
      seller: null,
      viewerAllyId: null,
      owner: null,
    }),
    false,
    "central tampoco puede operar una solicitud inexistente"
  );
});

test("retomar DataCredito usa GET, autoriza el borrador y conserva el scope historico", async () => {
  const [route, gate] = await Promise.all([
    readProjectFile("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
    readProjectFile(
      "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
    ),
  ]);
  const authorize = route.indexOf("canOperateSolicitud({");
  const historicalScope = route.indexOf("userId: requestedDraft.usuarioId");
  const decryptFallback = route.indexOf("getDataCreditoAssessmentResumeIdentity(");

  assert.ok(authorize >= 0);
  assert.ok(historicalScope > authorize);
  assert.ok(decryptFallback > historicalScope);
  assert.match(route, /sellerId: requestedDraft\.vendedorId/);
  assert.match(route, /sedeId: requestedDraft\.sedeId/);
  assert.match(route, /aliadoId: requestedDraft\.aliadoId/);
  assert.match(route, /!isDirectSalesProfile\(seller\?\.tipoPerfil\)/);
  assert.match(route, /if \(draftId && !authorizedDraft\)/);
  assert.match(route, /dataCreditoAssessmentMatchesScope\(row, scope\)/);
  assert.doesNotMatch(route, /queryDataCreditoNaturalPerson/);
  assert.match(gate, /method:\s*"POST"[\s\S]*solicitudId: initialSolicitudId/);
  assert.match(
    gate,
    /code === "ASSESSMENT_EXPIRED"[\s\S]{0,120}\[409, 410, 422\]\.includes\(response\.status\)/
  );
  assert.match(
    gate,
    /resolveMissingAssessmentGateView\(\{[\s\S]*expiredRequerySolicitudIdRef\.current/
  );
  assert.doesNotMatch(
    gate.slice(
      gate.indexOf("const loadInitialState"),
      gate.indexOf("const validateForm")
    ),
    /method:\s*"POST"/
  );
});

test("solo el vencimiento confirmado mantiene habilitada la nueva consulta en la misma solicitud", () => {
  assert.equal(
    resolveMissingAssessmentGateView({
      solicitudId: null,
      expiredRequerySolicitudId: null,
    }),
    "ready"
  );
  assert.equal(
    resolveMissingAssessmentGateView({
      solicitudId: 417,
      expiredRequerySolicitudId: null,
    }),
    "technical-error"
  );
  assert.equal(
    resolveMissingAssessmentGateView({
      solicitudId: 417,
      expiredRequerySolicitudId: 417,
    }),
    "ready"
  );
  assert.equal(
    resolveMissingAssessmentGateView({
      solicitudId: 418,
      expiredRequerySolicitudId: 417,
    }),
    "technical-error"
  );
});

test("solo el borrador propio de paso 1 con mismatch puede recuperar por apellido", () => {
  const recoverable = {
    reuseOnly: true,
    solicitudId: 530,
    currentStep: 1,
    storedDocument: "1.193.536.562",
    submittedDocument: "1193536562",
    storedPlatform: "iphone",
    submittedPlatform: "IPHONE",
    assessmentId: null,
    imei: null,
    errorCode: "ASSESSMENT_IDENTITY_MISMATCH",
  };

  assert.equal(canRecoverAssessmentIdentityMismatch(recoverable), true);
  for (const denied of [
    { reuseOnly: false },
    { solicitudId: null },
    { currentStep: 2 },
    { submittedDocument: "1193536563" },
    { submittedPlatform: "ANDROID" },
    { assessmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { imei: "355909998071255" },
    { errorCode: "PROVIDER_TIMEOUT" },
  ]) {
    assert.equal(
      canRecoverAssessmentIdentityMismatch({ ...recoverable, ...denied }),
      false
    );
  }
});

test("la recuperación de apellido es reuse-only y nunca alcanza al proveedor", async () => {
  const [route, gate, storage] = await Promise.all([
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
    readProjectFile(
      "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
    ),
    readProjectFile("lib/solicitudes-storage.ts"),
  ]);
  const reuseOnlyStop = route.indexOf("if (reuseOnly) {");
  const providerCall = route.indexOf("await queryDataCreditoNaturalPerson({");

  assert.match(route, /reuseOnly\?: unknown/);
  assert.match(route, /canRecoverAssessmentIdentityMismatch\(\{/);
  assert.match(route, /ASSESSMENT_RECOVERY_NOT_ALLOWED/);
  assert.match(route, /ASSESSMENT_REUSE_NOT_FOUND/);
  assert.ok(reuseOnlyStop >= 0);
  assert.ok(providerCall > reuseOnlyStop);
  assert.match(
    route.slice(reuseOnlyStop, providerCall),
    /return solicitudTechnicalResponse\(\{/
  );
  assert.match(
    route,
    /clientePrimerApellido: identityMismatchRecovery \? firstSurname : null/
  );

  assert.match(gate, /initialErrorCode\?: string \| null/);
  assert.match(gate, /reuseOnly: identityMismatchRecovery/);
  assert.match(gate, /Recuperar consulta vigente/);
  assert.match(gate, /!identityMismatchRecovery/);
  assert.match(
    gate,
    /ASSESSMENT_IDENTITY_MISMATCH[\s\S]{0,520}setView\("ready"\)/
  );

  assert.match(storage, /d\."currentStep"/);
  assert.match(storage, /dataCreditoErrorCode/);
  assert.match(
    storage,
    /jsonb_build_object\('clientePrimerApellido', \$7::text\)/
  );
});

test("RATE_LIMITED reabre el mismo borrador para un reintento normal, nunca reuse-only", async () => {
  const gate = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
  );
  const bootstrap = gate.slice(
    gate.indexOf("const loadInitialState"),
    gate.indexOf("const validateForm")
  );
  const submit = gate.slice(
    gate.indexOf("const submitAssessment"),
    gate.indexOf("const retryTechnicalFailure")
  );

  assert.match(
    gate,
    /const rateLimitedRecovery = Boolean\([\s\S]*initialSolicitudId[\s\S]*!initialAssessmentId[\s\S]*normalizedInitialDocument[\s\S]*normalizedInitialSurname[\s\S]*normalizedInitialErrorCode === "RATE_LIMITED"/
  );
  assert.match(
    bootstrap,
    /identityMismatchRecovery \|\| rateLimitedRecovery[\s\S]{0,220}setView\("ready"\)/
  );
  assert.match(
    submit,
    /solicitudId: initialSolicitudId[\s\S]{0,320}reuseOnly: identityMismatchRecovery/
  );
  assert.doesNotMatch(submit, /reuseOnly:\s*rateLimitedRecovery/);
});

test("un POST DataCredito retomado autoriza antes de reservar y reutiliza antes del proveedor", async () => {
  const route = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/route.ts"
  );
  const authorize = route.indexOf("!canOperateSolicitud({");
  const owner = route.indexOf("const solicitudOwner = solicitudContext ||");
  const reservation = route.indexOf("reserveSolicitudForIdentity({");
  const operationLock = route.indexOf(
    "await tryAcquireSolicitudOperationLock(solicitudReservation.id)"
  );
  const lockedRecheck = route.indexOf(
    "const lockedSolicitudContext = await getActiveSolicitudCreditContext(",
    operationLock
  );
  const reuse = route.indexOf("reuseDataCreditoAssessment({");
  const provider = route.indexOf("queryDataCreditoNaturalPerson({");

  assert.ok(authorize >= 0);
  assert.ok(owner > authorize);
  assert.ok(reservation > owner);
  assert.ok(operationLock > reservation);
  assert.ok(lockedRecheck > operationLock);
  assert.ok(reuse > lockedRecheck);
  assert.ok(provider > reuse);
  assert.match(route, /code: "SOLICITUD_NOT_AUTHORIZED"/);
  assert.match(route, /code: "SOLICITUD_OPERATION_IN_PROGRESS"/);
  assert.ok(route.includes('response.headers.set("Retry-After", "2")'));
  assert.ok(
    route
      .slice(route.lastIndexOf("} finally {"))
      .includes("await solicitudOperationLock?.release();")
  );
  for (const field of ["usuarioId", "vendedorId", "sedeId", "aliadoId"]) {
    assert.match(route, new RegExp(`solicitudOwner\\.${field}`));
  }
  assert.doesNotMatch(route, /const centralSolicitud =/);
});

test("central, vendedor o supervisor pueden consultar y la plataforma retomada no cambia", async () => {
  const [route, storage] = await Promise.all([
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
    readProjectFile("lib/solicitudes-storage.ts"),
  ]);
  const roleGuard = route.search(
    /if\s*\(\s*!central\s*&&\s*!isDirectSalesProfile\(\s*seller\?\.tipoPerfil\s*\)\s*\)/
  );
  const platformGuard = route.indexOf('code: "SOLICITUD_PLATAFORMA_DIFERENTE"');
  const reservation = route.indexOf("reserveSolicitudForIdentity({");
  const provider = route.indexOf("queryDataCreditoNaturalPerson({");

  assert.ok(roleGuard >= 0, "debe bloquear al admin de aliado y sesiones comerciales ausentes");
  assert.match(
    route,
    /const central =\s*admin && isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/
  );
  assert.match(
    route,
    /historicalPlatform[\s\S]{0,180}normalizeDataCreditoPlatform\(historicalPlatform\) !== platform/
  );
  assert.ok(platformGuard > roleGuard);
  assert.ok(reservation > platformGuard);
  assert.ok(provider > reservation);
  assert.match(storage, /SET "plataforma" = COALESCE\("plataforma", \$2\)/);
  assert.match(storage, /"plataforma" = COALESCE\("plataforma", \$3\)/);
  assert.doesNotMatch(storage, /"plataforma" = COALESCE\(\$[23], "plataforma"\)/);
});

test("el autoguardado vacio conserva el IMEI canonico", async () => {
  const storage = await readProjectFile("lib/solicitudes-storage.ts");

  assert.match(storage, /const payloadImei = normalizeDigits\(canonicalPayload\.imei\)/);
  assert.match(
    storage,
    /const payloadDeviceUid = normalizeDigits\(canonicalPayload\.deviceUid\)/
  );
  assert.match(storage, /new Set\(incomingImeis\)\.size > 1/);
  assert.match(
    storage,
    /incomingImeis\.some\(\(candidate\) => candidate !== storedImei\)/
  );
  assert.match(
    storage,
    /const canonicalImei =[\s\S]{0,180}\(storedStep >= 3 \? storedImei : ""\)[\s\S]{0,180}payloadDeviceUid[\s\S]{0,100}storedImei/
  );
  assert.match(
    storage,
    /\{ imei: canonicalImei, deviceUid: canonicalImei \}/
  );
  assert.match(
    storage,
    /"imei" = COALESCE\(NULLIF\(\$6::text, ''\), "imei"\)/
  );
});

test("autosave, desistimiento y vencimiento comparten el lock de operacion", async () => {
  const [storage, firmaStorage] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("lib/firmaseguro-storage.ts"),
  ]);

  assert.match(firmaStorage, /export const SOLICITUD_OPERATION_LOCK_NAMESPACE/);
  assert.match(
    firmaStorage,
    /FIRMASEGURO_DRAFT_LOCK_NAMESPACE\s*=\s*\n?\s*SOLICITUD_OPERATION_LOCK_NAMESPACE/
  );
  assert.match(firmaStorage, /lockSolicitudOperationMutation/);
  assert.match(firmaStorage, /tryAcquireSolicitudOperationLock/);
  assert.match(
    firmaStorage,
    /tryAcquireFirmaSeguroDraftDispatchLock[\s\S]{0,120}tryAcquireSolicitudOperationLock/
  );
  assert.match(firmaStorage, /pg_advisory_xact_lock/);
  assert.match(
    storage,
    /lockSolicitudOperationsInOrder[\s\S]{0,260}\.sort\(\(left, right\) => left - right\)[\s\S]{0,180}lockSolicitudOperationMutation\(database, id\)/
  );
  assert.equal(
    [...storage.matchAll(/lockSolicitudOperationsInOrder\(\s*transaction,/g)]
      .length,
    2
  );
  assert.match(storage, /if \(targetId\) await lockSolicitudOperationMutation\(transaction, targetId\)/);
  assert.match(storage, /pg_try_advisory_xact_lock/);
  assert.match(storage, /SOLICITUD_OPERATION_LOCK_NAMESPACE/);
});

test("el autoguardado no altera terminos ya enviados a FirmaSeguro", async () => {
  const [storage, solicitud] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("lib/solicitudes.ts"),
  ]);
  const fieldsBlock = storage.slice(
    storage.indexOf("const FIRMASEGURO_SIGNED_DRAFT_FIELDS"),
    storage.indexOf("] as const;", storage.indexOf("const FIRMASEGURO_SIGNED_DRAFT_FIELDS"))
  );

  for (const field of [
    "clienteDocumento",
    "clienteNombre",
    "imei",
    "plataformaDispositivo",
    "valorEquipoTotal",
    "cuotaInicial",
    "plazoMeses",
  ]) {
    assert.match(fieldsBlock, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(fieldsBlock, /fotoEntrega|fotoRemision|cedulaFrenteDataUrl/);
  assert.match(storage, /FROM "FirmaSeguroProcess"[\s\S]{0,180}ORDER BY "id" DESC/);
  assert.match(storage, /firmaSeguroTermsAreLocked\(firmaSeguroTerms\)/);
  assert.match(storage, /SOLICITUD_TERMINOS_FIRMADOS_INMUTABLE/);
  assert.match(solicitud, /SOLICITUD_TERMINOS_FIRMADOS_INMUTABLE/);
});

test("el PATCH de borradores conserva DESISTIR pero no puede finalizar creditos", async () => {
  const route = await readProjectFile("app/api/creditos/borradores/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));

  assert.match(patch, /sanitizeText\(body\.action\)\.toUpperCase\(\) === "DESISTIR"/);
  assert.match(patch, /code: "SOLICITUD_FINALIZACION_ATOMICA_REQUERIDA"/);
  assert.match(patch, /\{ status: 405 \}/);
  assert.doesNotMatch(patch, /"closedReason" = 'FINALIZADA'/);
  assert.doesNotMatch(patch, /parsePositiveId\(body\.creditoId\)/);
});

test("la fabrica directa permite perfiles comerciales y bloquea al admin aliado al guardar", async () => {
  const route = await readProjectFile("app/api/creditos/borradores/route.ts");
  const getSource = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST")
  );
  const postSource = route.slice(
    route.indexOf("export async function POST"),
    route.indexOf("export async function PATCH")
  );
  const patchSource = route.slice(route.indexOf("export async function PATCH"));

  assert.match(
    getSource,
    /!access\.admin\s*&&\s*!isDirectSalesProfile\(access\.seller\?\.tipoPerfil\)/
  );
  assert.match(
    postSource,
    /!access\.central\s*&&\s*!isDirectSalesProfile\(access\.seller\?\.tipoPerfil\)/
  );
  assert.match(
    patchSource,
    /!access\.seller\s*\|\|\s*!isDirectSalesProfile\(access\.seller\.tipoPerfil\)/
  );
  for (const source of [getSource, postSource, patchSource]) {
    assert.match(source, /expireStaleSolicitudes\(\)/);
  }
});

test("Veriff y FirmaSeguro no operan una solicitud vencida por ruta directa", async () => {
  const [veriff, veriffStorage, firma] = await Promise.all([
    readProjectFile("app/api/creditos/veriff/route.ts"),
    readProjectFile("lib/veriff-storage.ts"),
    readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
  ]);

  assert.match(veriff, /expireStaleSolicitudes\(\)/);
  assert.match(veriff, /INTERVAL '15 days'/);
  assert.match(veriffStorage, /draft\."createdAt" \+ INTERVAL '15 days'/);
  assert.match(firma, /expireStaleSolicitudes\(\)/);
  assert.match(firma, /INTERVAL '15 days'/);
});

test("Veriff, FirmaSeguro e iPhone permiten al titular por aliado y preservan el dueño", async () => {
  const [veriffAccess, veriffCreate, firma, iphone] = await Promise.all([
    readProjectFile("lib/veriff-access.ts"),
    readProjectFile("app/api/creditos/veriff/route.ts"),
    readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
    readProjectFile(
      "app/api/creditos/borradores/[id]/iphone-enrollment/route.ts"
    ),
  ]);

  assert.match(veriffAccess, /canSellerOperateSolicitud\(seller, user\.aliadoId, row\)/);
  assert.doesNotMatch(veriffAccess, /row\.sedeId === seller\.sedeId/);
  assert.match(veriffCreate, /usuarioId: draft\.usuarioId/);
  assert.match(veriffCreate, /sedeId: draft\.sedeId/);
  assert.match(veriffCreate, /vendedorId: draft\.vendedorId/);
  assert.match(firma, /d\."vendedorId" = \$\$\{values\.length\}/);
  assert.match(firma, /s\."aliadoId" = \$\$\{values\.length\}/);
  assert.match(
    firma,
    /!isDirectSalesProfile\(seller(?:Session)?\?\.tipoPerfil\)/
  );
  assert.doesNotMatch(
    firma.slice(firma.indexOf("} else if (!admin)"), firma.indexOf("const rows =")),
    /user\.sedeId|d\."sedeId"/
  );
  assert.match(iphone, /draft\."vendedorId" = \$\$\{values\.length\}/);
  assert.match(iphone, /sede\."aliadoId" = \$\$\{values\.length\}/);
  assert.match(iphone, /!isDirectSalesProfile\(seller\?\.tipoPerfil\)/);
  assert.doesNotMatch(iphone, /seller\?\.sedeId/);
});

test("Equality y el cierre quedan vinculados al mismo borrador, IMEI y evidencias", async () => {
  const [equality, factory, close] = await Promise.all([
    readProjectFile("app/api/equality/route.ts"),
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
    readProjectFile("app/api/creditos/route.ts"),
  ]);

  const equalityAuthorize = equality.indexOf("canOperateSolicitud({");
  const equalityProvider = equality.indexOf("switch (action)");
  assert.ok(equalityAuthorize >= 0);
  assert.ok(equalityProvider > equalityAuthorize);
  assert.match(equality, /getActiveSolicitudCreditContext\(draftId\)/);
  assert.match(equality, /draftDeviceUid !== deviceUid/);
  assert.match(equality, /draft\.plataforma[\s\S]{0,120}ANDROID/);
  const equalityLock = equality.indexOf(
    "operationLock = await tryAcquireSolicitudOperationLock(draftId)"
  );
  const equalityRecheck = equality.indexOf(
    "const accessError = await validateDraftAccess();",
    equalityLock
  );
  assert.ok(equalityLock > equalityAuthorize);
  assert.ok(equalityRecheck > equalityLock);
  assert.ok(equalityProvider > equalityRecheck);
  assert.match(equality, /action !== "query" && draftId/);
  assert.match(equality, /finally \{[\s\S]{0,100}operationLock\?\.release\(\)/);
  assert.match(factory, /body: JSON\.stringify\(\{[\s\S]{0,100}action,[\s\S]{0,100}draftId,[\s\S]{0,100}deviceUid: imeiDigits/);

  assert.match(close, /canOperateSolicitudContext\(\{[\s\S]*owner: solicitudContext/);
  assert.doesNotMatch(close, /solicitudContext\.sedeId === sellerSession\.sedeId/);
  assert.match(close, /code: "SOLICITUD_IMEI_DIFERENTE"/);
  const closeLock = close.indexOf(
    "await tryAcquireSolicitudOperationLock(requestedSolicitudId)"
  );
  const closeRecheck = close.indexOf(
    "await getActiveSolicitudCreditContext(requestedSolicitudId)",
    closeLock
  );
  const dataCreditoClaim = close.indexOf(
    "const claimed = await claimDataCreditoAssessment(",
    closeRecheck
  );
  const equalityMutation = close.indexOf(
    "uploadEqualityInventoryDevice(deviceUid)",
    closeRecheck
  );
  const completeSolicitud = close.indexOf(
    "await completeSolicitudForCredit(",
    equalityMutation
  );
  assert.ok(closeLock >= 0);
  assert.ok(closeRecheck > closeLock);
  assert.ok(dataCreditoClaim > closeRecheck);
  assert.ok(equalityMutation > dataCreditoClaim);
  assert.ok(completeSolicitud > equalityMutation);
  const finallyBlock = close.slice(close.lastIndexOf("} finally {"));
  assert.match(finallyBlock, /releaseDataCreditoAssessment\(dataCreditoClaim\)/);
  assert.ok(
    finallyBlock.indexOf("releaseDataCreditoAssessment(dataCreditoClaim)") <
      finallyBlock.indexOf("solicitudOperationLock?.release()")
  );
  assert.match(close, /storedFirmaSeguroProcess\.draftId !== solicitudContext\.id/);
  assert.match(close, /code: "FIRMASEGURO_DRAFT_MISMATCH"/);
  assert.match(
    close,
    /canAccessVeriffValidation\(user, veriffValidation, sellerSession\)/
  );
  assert.match(close, /veriffValidation\.draftId !== solicitudReservation\.id/);
  assert.doesNotMatch(close, /const sameSede = veriffValidation\.sedeId/);
});
