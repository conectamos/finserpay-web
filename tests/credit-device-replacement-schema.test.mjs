import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readProjectFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [schema, predeploy, dockerfile] = await Promise.all([
  readProjectFile("scripts/ensure-credit-device-replacement-schema.mjs"),
  readProjectFile("scripts/railway-predeploy.mjs"),
  readProjectFile("Dockerfile"),
]);

test("el esquema crea reemplazo, revision y bitacora con relaciones restrictivas", () => {
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS public\."CreditDeviceReplacement"/
  );
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS public\."CreditDeviceReplacementReview"/
  );
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS public\."CreditDeviceReplacementEvent"/
  );
  assert.match(
    schema,
    /FOREIGN KEY \("creditId"\) REFERENCES public\."Credito"\("id"\) ON DELETE RESTRICT/
  );
  assert.match(
    schema,
    /FOREIGN KEY \("solicitudId"\) REFERENCES public\."CreditoBorrador"\("id"\) ON DELETE RESTRICT/
  );
  const replacementForeignKeys = schema.match(
    /FOREIGN KEY \("replacementId"\)[\s\S]*?REFERENCES public\."CreditDeviceReplacement"\("id"\) ON DELETE RESTRICT/g
  );
  assert.equal(replacementForeignKeys?.length, 2);
  assert.match(
    schema,
    /FOREIGN KEY \("grantId"\)[\s\S]*REFERENCES public\."IphoneEnrollmentAccessGrant"\("id"\) ON DELETE RESTRICT/
  );
});

test("el esquema limita los estados del reemplazo y de sus eventos", () => {
  assert.match(
    schema,
    /CHECK \("status" IN \('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED', 'COMPLETED', 'CANCELLED'\)\)/
  );
  assert.match(
    schema,
    /CHECK \("eventType" IN \('CREATED', 'ENROLLMENT_APPROVED', 'COMPLETED', 'CANCELLED'\)\)/
  );
  assert.match(
    schema,
    /CHECK \("actorType" IN \('USER', 'ANALYST', 'SYSTEM_SUPPORT'\)\)/
  );
});

test("el predeploy reconcilia columnas y reemplaza constraints de ciclo de vida", () => {
  assert.match(
    schema,
    /ALTER TABLE public\."CreditDeviceReplacement"[\s\S]*ADD COLUMN IF NOT EXISTS "requestedCreditUpdatedAt" TIMESTAMPTZ[\s\S]*ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ/
  );
  assert.match(
    schema,
    /ALTER TABLE public\."CreditDeviceReplacementReview"[\s\S]*ADD COLUMN IF NOT EXISTS "replacementId" UUID[\s\S]*ADD COLUMN IF NOT EXISTS "accessFingerprint" CHAR\(64\)/
  );
  assert.match(
    schema,
    /ALTER COLUMN "requestedCreditUpdatedAt" SET NOT NULL[\s\S]*ALTER COLUMN "correlationId" SET NOT NULL/
  );
  assert.match(
    schema,
    /ALTER COLUMN "replacementId" SET NOT NULL[\s\S]*ALTER COLUMN "accessFingerprint" SET NOT NULL/
  );
  for (const constraint of [
    "CreditDeviceReplacement_status_check",
    "CreditDeviceReplacement_imei_check",
    "CreditDeviceReplacement_reason_check",
    "CreditDeviceReplacement_completion_check",
    "CreditDeviceReplacement_cancellation_check",
  ]) {
    assert.match(schema, new RegExp(`DROP CONSTRAINT IF EXISTS "${constraint}"`));
    assert.match(schema, new RegExp(`ADD CONSTRAINT "${constraint}"`));
  }
  assert.match(
    schema,
    /"status" = 'COMPLETED'[\s\S]*"completedByUserId" IS NOT NULL[\s\S]*"completedByName"[\s\S]*"completedAt" IS NOT NULL/
  );
  assert.match(
    schema,
    /"status" = 'CANCELLED'[\s\S]*"cancelledByUserId" IS NOT NULL[\s\S]*"cancelledByName"[\s\S]*"cancelledReason"[\s\S]*"cancelledAt" IS NOT NULL/
  );
});

test("el reemplazo conserva identidad y solo acepta transiciones autorizadas", () => {
  const functionStart = schema.indexOf(
    'CREATE OR REPLACE FUNCTION public."enforce_credit_device_replacement_lifecycle"()'
  );
  const functionEnd = schema.indexOf(
    'DROP TRIGGER IF EXISTS "CreditDeviceReplacement_lifecycle"',
    functionStart
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const lifecycle = schema.slice(functionStart, functionEnd);

  for (const field of [
    "creditId",
    "solicitudId",
    "previousImei",
    "newImei",
    "reason",
    "requestedCreditUpdatedAt",
    "createdByUserId",
    "createdByName",
    "createdByUsername",
    "source",
    "correlationId",
  ]) {
    assert.match(
      lifecycle,
      new RegExp(`NEW\\."${field}" IS DISTINCT FROM OLD\\."${field}"`)
    );
  }
  assert.match(
    lifecycle,
    /OLD\."status" = 'PENDING_ENROLLMENT'[\s\S]*NEW\."status" IN \('ENROLLMENT_APPROVED', 'CANCELLED'\)/
  );
  assert.match(
    lifecycle,
    /OLD\."status" = 'ENROLLMENT_APPROVED'[\s\S]*NEW\."status" IN \('COMPLETED', 'CANCELLED'\)/
  );
  assert.match(
    schema,
    /CREATE TRIGGER "CreditDeviceReplacement_lifecycle"[\s\S]*BEFORE INSERT OR UPDATE ON public\."CreditDeviceReplacement"/
  );
});

test("aprobar o completar exige una revision aprobada y verificable", () => {
  assert.match(
    schema,
    /NEW\."status" IN \('ENROLLMENT_APPROVED', 'COMPLETED'\)[\s\S]*NOT EXISTS \([\s\S]*FROM public\."CreditDeviceReplacementReview" review[\s\S]*review\."replacementId" = NEW\."id"[\s\S]*review\."decision" = 'APROBADO'/
  );
  assert.match(
    schema,
    /WHERE replacement\."status" IN \('ENROLLMENT_APPROVED', 'COMPLETED'\)[\s\S]*NOT EXISTS \([\s\S]*review\."replacementId" = replacement\."id"/
  );
});

test("solo puede existir un reemplazo activo por credito o IMEI nuevo", () => {
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacement_active_credit_key"[\s\S]*ON public\."CreditDeviceReplacement" \("creditId"\)[\s\S]*WHERE "status" IN \('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED'\)/
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacement_active_new_imei_key"[\s\S]*ON public\."CreditDeviceReplacement" \("newImei"\)[\s\S]*WHERE "status" IN \('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED'\)/
  );
});

test("las revisiones y eventos de reemplazo son append-only", () => {
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION public\."prevent_credit_device_replacement_review_mutation"\(\)/
  );
  assert.match(
    schema,
    /RAISE EXCEPTION 'CreditDeviceReplacementReview is append-only'/
  );
  assert.match(
    schema,
    /CREATE TRIGGER "CreditDeviceReplacementReview_immutable"[\s\S]*BEFORE UPDATE OR DELETE ON public\."CreditDeviceReplacementReview"[\s\S]*FOR EACH ROW EXECUTE FUNCTION public\."prevent_credit_device_replacement_review_mutation"\(\)/
  );
  assert.match(
    schema,
    /CREATE OR REPLACE FUNCTION public\."prevent_credit_device_replacement_event_mutation"\(\)/
  );
  assert.match(
    schema,
    /RAISE EXCEPTION 'CreditDeviceReplacementEvent is append-only'/
  );
  assert.match(
    schema,
    /CREATE TRIGGER "CreditDeviceReplacementEvent_immutable"[\s\S]*BEFORE UPDATE OR DELETE ON public\."CreditDeviceReplacementEvent"[\s\S]*FOR EACH ROW EXECUTE FUNCTION public\."prevent_credit_device_replacement_event_mutation"\(\)/
  );
});

test("Railway ejecuta el esquema despues de sus dependencias y Docker lo incluye", () => {
  const solicitudesPosition = predeploy.indexOf(
    'import("./ensure-solicitudes-schema.mjs")'
  );
  const enrollmentPosition = predeploy.indexOf(
    'import("./ensure-iphone-enrollment-schema.mjs")'
  );
  const replacementPosition = predeploy.indexOf(
    'import("./ensure-credit-device-replacement-schema.mjs")'
  );

  assert.ok(solicitudesPosition >= 0, "falta preparar CreditoBorrador");
  assert.ok(enrollmentPosition >= 0, "falta preparar IphoneEnrollmentReview");
  assert.ok(replacementPosition > solicitudesPosition);
  assert.ok(replacementPosition > enrollmentPosition);
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/scripts\/ensure-credit-device-replacement-schema\.mjs \.\/scripts\/ensure-credit-device-replacement-schema\.mjs/
  );
  assert.match(schema, /SET LOCAL lock_timeout = '10s'/);
  assert.match(schema, /SET LOCAL statement_timeout = '120s'/);
});
