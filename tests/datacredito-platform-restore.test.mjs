import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFile(path.join(projectRoot, file), "utf8");

const [storage, assessmentRoute, gate, factory] = await Promise.all([
  source("lib/datacredito/storage.ts"),
  source("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
  source("app/dashboard/creditos/datacredito-prequalification-gate.tsx"),
  source("app/dashboard/creditos/credit-factory-console.tsx"),
]);

test("la evaluacion serializada conserva su plataforma autentica", () => {
  const serializer = storage.match(
    /export function serializeDataCreditoAssessment\([\s\S]*?\n\}/
  )?.[0];

  assert.ok(serializer);
  assert.match(serializer, /platform:\s*row\.platform/);
});

test("la restauracion valida la plataforma esperada", () => {
  assert.match(assessmentRoute, /normalizeDataCreditoPlatform/);
  assert.match(assessmentRoute, /searchParams\.get\("platform"\)/);
  assert.match(
    assessmentRoute,
    /expectedPlatform\s*&&\s*row\.platform\s*!==\s*expectedPlatform/
  );
  assert.match(assessmentRoute, /ASSESSMENT_PLATFORM_MISMATCH/);
});

test("el gate solicita, valida y entrega la plataforma sin reetiquetarla", () => {
  assert.match(gate, /platform:\s*DataCreditoPlatform/);
  assert.match(gate, /readPlatform\(source\.platform\)/);
  assert.match(gate, /\?platform=\$\{encodeURIComponent\(platform\)\}/);
  assert.match(gate, /approved\.platform\s*!==\s*platform/);
  assert.match(gate, /code === "ASSESSMENT_PLATFORM_MISMATCH"/);

  assert.match(factory, /setDataCreditoApproval\(result\)/);
  assert.doesNotMatch(
    factory,
    /setDataCreditoApproval\(\{\s*\.\.\.result,\s*platform:\s*dataCreditoPlatform\s*\}\)/
  );
});
