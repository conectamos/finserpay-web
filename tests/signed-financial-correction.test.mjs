import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

test("el endpoint de corrección financiera exige administrador central", async () => {
  const source = await readProjectFile(
    "app/api/creditos/borradores/[id]/terminos-firmados/route.ts",
  );

  assert.match(source, /getSessionUser\(\)/);
  assert.match(source, /!isAdminRole\(user\.rolNombre\)/);
  assert.match(source, /!isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/);
  assert.match(source, /CORRECCION_FINANCIERA_NO_AUTORIZADA/);
  assert.match(source, /correctFirmaSeguroDraftFinancialTerms/);
  assert.doesNotMatch(source, /getApprovalSharedRequestActor|getCreditApprovalSessionUser/);
});

test("la corrección conserva la firma anterior, archiva la remisión y exige nueva firma", async () => {
  const source = await readProjectFile(
    "lib/firmaseguro-financial-correction.ts",
  );

  assert.match(source, /expectedProcessUuid/);
  assert.match(source, /expectedFinancialTermsChecksum/);
  assert.match(source, /readFinancingTermsSeal/);
  assert.match(source, /hasSignedPdf\(activeProcess\)/);
  assert.match(source, /getUnresolvedDraftDispatch/);
  assert.match(source, /markFirmaSeguroDraftProcessesSuperseded/);
  assert.match(source, /firmaSeguroFinancialCorrectionPending: true/);
  assert.match(source, /delete nextPayload\.financialTermsSeal/);
  assert.match(source, /delete nextPayload\.firmaSeguroDraftFolio/);
  assert.match(source, /delete nextPayload\.fotoRemisionDataUrl/);
  assert.match(source, /"currentStep"=4/);
  assert.match(source, /SolicitudFinancialCorrectionAudit/);
  assert.match(source, /BEFORE UPDATE OR DELETE/);
  assert.match(source, /FirmaSeguroProcess_financial_history_immutable/);
  assert.match(source, /Historical FirmaSeguro contract evidence is immutable/);
  assert.match(source, /recordFirmaSeguroFinancialCorrectionReissue/);
  assert.match(source, /sameFinancialValues/);
  assert.doesNotMatch(
    source,
    /JSON\.stringify\(prior\.afterFinancial\)\s*!==\s*JSON\.stringify\(afterFinancial\)/,
  );
  assert.ok(
    source.indexOf("await buildDraftCredit") <
      source.indexOf("await markFirmaSeguroDraftProcessesSuperseded"),
    "la política debe validarse antes de archivar el contrato firmado",
  );
  assert.match(source, /CORRECCION_FINANCIERA_AJUSTE_REQUERIDO/);
  assert.match(
    source,
    /afterFinancial\.cuotaInicial >= afterFinancial\.valorEquipoTotal/,
  );
});

test("la instalación del esquema financiero se serializa en una sola transacción", async () => {
  const source = await readProjectFile(
    "lib/firmaseguro-financial-correction.ts",
  );
  const installer = source.slice(
    source.indexOf("export function ensureFirmaSeguroFinancialCorrectionSchema"),
    source.indexOf("async function readActiveProcess"),
  );
  const transaction = installer.indexOf("prisma.$transaction(async (database)");
  const lock = installer.indexOf("pg_advisory_xact_lock");
  const firstDdl = installer.indexOf('CREATE TABLE IF NOT EXISTS "SolicitudFinancialCorrectionAudit"');

  assert.ok(transaction >= 0, "el instalador debe abrir una transacción");
  assert.ok(lock > transaction, "el bloqueo debe adquirirse dentro de la transacción");
  assert.ok(firstDdl > lock, "el bloqueo debe preceder a todo el DDL");
  assert.match(
    installer,
    /database\.\$executeRawUnsafe\([\s\S]*pg_advisory_xact_lock/,
  );
  assert.doesNotMatch(installer, /await prisma\.\$executeRawUnsafe/);
  assert.match(installer, /\}, \{ timeout: 30_000 \}\)/);
});

test("la nueva firma recalcula el sello y no reutiliza términos congelados", async () => {
  const source = await readProjectFile(
    "app/api/creditos/borradores/[id]/firma-seguro/route.ts",
  );

  assert.match(
    source,
    /const financialCorrectionPending =\s*sourcePayload\.firmaSeguroFinancialCorrectionPending === true/,
  );
  assert.match(source, /if \(source && frozenCorrectionPending\)/);
  assert.match(source, /const built = await buildDraftCredit\(lockedAuthorized\.row\)/);
  assert.match(source, /createFinancingTermsSeal/);
  assert.match(source, /recordFirmaSeguroFinancialCorrectionReissue/);
  assert.match(source, /financialCorrectionReissue/);
  assert.match(source, /valorEquipoTotal: String\(credit\.valorEquipoTotal\)/);
  assert.match(source, /cuotaInicial: String\(credit\.cuotaInicial\)/);
  assert.match(source, /plazoMeses: String\(credit\.plazoMeses\)/);
  assert.doesNotMatch(source, /process: serializeFirmaSeguroProcess\(/);
});

test("la interfaz reusa la clave y reconcilia una respuesta de red incierta", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx",
  );

  assert.match(source, /const signedTermsCorrectionRequestRef = useRef/);
  assert.match(
    source,
    /previousRequest\?\.fingerprint === requestFingerprint[\s\S]{0,180}previousRequest\.idempotencyKey/,
  );
  assert.match(source, /idempotencyKey,\s*expectedProcessUuid/);
  assert.match(
    source,
    /firmaSeguroFinancialCorrectionPending === true[\s\S]{0,220}=== idempotencyKey/,
  );
  assert.match(source, /applyDraftPayload\(authoritativeDraft\)/);
  assert.match(source, /cuotaInicial >= valorEquipoTotal/);
});

test("un autosave antiguo no restaura valores ni la foto de remisión", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");

  assert.match(source, /firmaSeguroFinancialCorrectionPending/);
  assert.match(source, /firmaSeguroFinancialCorrectionId/);
  assert.match(source, /FIRMASEGURO_SIGNED_DRAFT_FIELDS/);
  assert.match(source, /SOLICITUD_CORRECCION_FINANCIERA_PENDIENTE/);
  assert.match(source, /delete canonicalPayload\[field\]/);
  assert.match(source, /"fotoRemisionDataUrl"/);
  assert.match(source, /financialCorrectionPending\s*\? 4/);
  assert.match(source, /WHEN \$10::boolean THEN 4/);
});

test("el reenvío conserva el bloqueo hasta recibir un PDF firmado", async () => {
  const source = await readProjectFile(
    "lib/firmaseguro-financial-correction.ts",
  );

  const reissueSource = source.slice(
    source.indexOf("export async function recordFirmaSeguroFinancialCorrectionReissue"),
  );
  const signedGuard = reissueSource.indexOf("if (!hasSignedPdf(process)) return true;");
  const auditInsert = reissueSource.indexOf(
    '`INSERT INTO "SolicitudFinancialCorrectionAudit"',
  );
  const markerRemoval = reissueSource.indexOf(
    "- 'firmaSeguroFinancialCorrectionPending'",
  );
  assert.ok(signedGuard >= 0);
  assert.ok(auditInsert > signedGuard);
  assert.ok(markerRemoval > signedGuard);
  assert.match(reissueSource, /reissuedFinancial/);
  assert.match(reissueSource, /\$5::jsonb/);
});
