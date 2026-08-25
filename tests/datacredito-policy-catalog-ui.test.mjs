import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [consoleSource, pageSource] = await Promise.all([
  readFile(
    new URL(
      "../app/dashboard/parametros-credito/datacredito-policy-console.tsx",
      import.meta.url
    ),
    "utf8"
  ),
  readFile(
    new URL(
      "../app/dashboard/parametros-credito/page.tsx",
      import.meta.url
    ),
    "utf8"
  ),
]);

test("usa una sola vista de edición basada en políticas", () => {
  assert.match(pageSource, /import DatacreditoPolicyConsole/);
  assert.doesNotMatch(pageSource, /CreditParametersConsole/);
  assert.match(pageSource, /href="\/dashboard"/);
  assert.match(pageSource, /href="\/dashboard\/creditos"/);
  assert.match(pageSource, /Políticas de crédito \| FINSER PAY/);
  assert.equal((consoleSource.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(consoleSource, /Fianza de banda legada/);
  assert.doesNotMatch(
    consoleSource,
    /excepción\s+explícita\s+por\s+cédula/i
  );
});

test("edita monto, plazo y tope de cuota desde cada banda DataCrédito", () => {
  assert.match(consoleSource, /installmentCount: number/);
  assert.match(consoleSource, /maxInstallmentAmount: number \| null/);
  assert.match(consoleSource, /Plazo máximo \(cuotas\)/);
  assert.match(consoleSource, /Monto máximo a financiar/);
  assert.match(consoleSource, /Tope de cuota iPhone/);
  assert.match(
    consoleSource,
    /MAX_INSTALLMENT_COUNT = DATACREDITO_MAX_INSTALLMENT_COUNT/
  );
  assert.match(
    consoleSource,
    /DEFAULT_ANDROID_INSTALLMENT_COUNT =\s*DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT/
  );
  assert.match(
    consoleSource,
    /DEFAULT_IPHONE_INSTALLMENT_COUNT =\s*DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT/
  );
  assert.match(
    consoleSource,
    /DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT =\s*DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT/
  );
  assert.match(consoleSource, /suretyPercentage: String\(band\.suretyPercentage\)/);
});

test("gestiona un catálogo de políticas con revisiones inmutables", () => {
  assert.match(
    consoleSource,
    /fetch\("\/api\/creditos\/datacredito\/politicas"/
  );
  assert.match(consoleSource, /method: "POST"/);
  assert.match(consoleSource, /bands: selectedProfile\.bands/);
  assert.match(consoleSource, /action: "SAVE_REVISION"/);
  assert.match(consoleSource, /expectedVersion: version/);
  assert.match(consoleSource, /POLICY_VERSION_CONFLICT/);
  assert.match(consoleSource, /Publicar nueva versión/);
  assert.match(consoleSource, /no reemplazará ni modificará revisiones históricas/);
});

test("asigna siempre una política nombrada a cada aliado con concurrencia optimista", () => {
  assert.match(consoleSource, /action: "ASSIGN_ALLY"/);
  assert.match(consoleSource, /expectedPolicyId: change\.ally\.policyId/);
  assert.match(consoleSource, /POLICY_ASSIGNMENT_CONFLICT/);
  assert.match(consoleSource, /value=\{draftPolicyId\}/);
  assert.match(consoleSource, /Guardar reasignaciones/);
  assert.match(consoleSource, /exactamente una a cada aliado/);
  assert.match(consoleSource, /solo (?:afectan|se aplicarán a) consultas futuras/i);
});

test("la consola conserva navegación accesible y estados responsivos", () => {
  assert.match(consoleSource, /<Tabs aria-label="Gestión de políticas DataCrédito">/);
  assert.match(consoleSource, /role="tab"/);
  assert.match(consoleSource, /role="tabpanel"/);
  assert.match(consoleSource, /aria-controls="datacredito-policies-panel"/);
  assert.match(consoleSource, /aria-controls="datacredito-assignments-panel"/);
  assert.match(consoleSource, /<DataTable className="mt-5">/);
  assert.match(consoleSource, /aria-label=\{`Política para \$\{ally\.name\}`\}/);
});


test("tolera aliados sin código y muestra un fallback legible", () => {
  assert.match(consoleSource, /code: string \| null/);
  assert.match(consoleSource, /ally\.code \|\| "Sin código"/);
  assert.match(consoleSource, /ally\.code \|\| ""/);
  assert.doesNotMatch(consoleSource, /!name \|\|\s*!code \|\|\s*!policyId/);
});

test("preserva borradores de asignación y limpia solo aliados confirmados", () => {
  assert.match(consoleSource, /preserveAssignmentDrafts = false/);
  assert.match(consoleSource, /confirmedAllyIds: number\[\] = \[\]/);
  assert.match(consoleSource, /confirmedAllyIdSet\.has\(ally\.id\)/);
  assert.match(consoleSource, /completedAllyIds\.push\(change\.ally\.id\)/);
  assert.match(consoleSource, /applyCatalog\(catalog, selectedProfile\.id, false, true\)/);
  assert.match(consoleSource, /applyCatalog\(catalog, createdPolicyId, false, true\)/);
});

test("bloquea duplicar un borrador y usa la fecha de la revisión publicada", () => {
  assert.match(consoleSource, /revisionCreatedAt: string \| null/);
  assert.match(consoleSource, /readString\(value\.revisionCreatedAt\)/);
  assert.match(
    consoleSource,
    /profile\?\.revisionCreatedAt \?\? profile\?\.updatedAt \?\? null/
  );
  assert.match(
    consoleSource,
    /!selectedProfile \|\| saving \|\| creating \|\| hasUnsavedChanges/
  );
  assert.match(consoleSource, /Publica los cambios o recarga para descartarlos/);
});

test("configura dos umbrales TELCOS versionados antes de las bandas", () => {
  assert.match(
    consoleSource,
    /priorityRules: DataCreditoPolicyPriorityRules \| null/
  );
  assert.match(
    consoleSource,
    /DEFAULT_PRIORITY_REJECTION_AMOUNT_COP = 2_000_000/
  );
  assert.match(
    consoleSource,
    /parsePriorityRules\(value\.priorityRules, `Política \$\{index \+ 1\}`\)/
  );
  assert.match(consoleSource, /telcoDelinquency\.enabled !== true/);
  assert.doesNotMatch(consoleSource, /totalDelinquency/);
  assert.match(
    consoleSource,
    /MAX_PRIORITY_REJECTION_AMOUNT_COP =\s*DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT/
  );
  assert.match(consoleSource, /rejectAboveCopByPlatform:\s*\{/);
  assert.match(
    consoleSource,
    /ANDROID: DEFAULT_PRIORITY_REJECTION_AMOUNT_COP[\s\S]*IPHONE: DEFAULT_PRIORITY_REJECTION_AMOUNT_COP/
  );
  assert.match(consoleSource, /PLATFORMS\.map\(\(platform\)/);
  assert.match(
    consoleSource,
    /platform === "ANDROID" \? "Android" : "iPhone"/
  );
  assert.match(consoleSource, /Mora TELCOS \{platformLabel\} superior a \(COP\)/);
  assert.match(consoleSource, /\$\{idPrefix\}-\$\{platformKey\}-threshold/);
  assert.match(consoleSource, /onThresholdChange\(platform, event\.target\.value\)/);
  assert.match(consoleSource, /max=\{MAX_PRIORITY_REJECTION_AMOUNT_COP\}/);
  assert.match(consoleSource, /Prioridad 1 · activa/);
  assert.match(consoleSource, /<StatusPill tone="danger">RECHAZADO<\/StatusPill>/);
  assert.match(
    consoleSource,
    /Rechaza únicamente la solicitud de la plataforma cuyo umbral fue[\s\S]*superado/
  );
  assert.match(
    consoleSource,
    /Solo[\s\S]*rechaza esta plataforma cuando la mora es mayor; el valor[\s\S]*exacto no activa la regla/
  );
  assert.match(
    consoleSource,
    /Android superior a \$\{formatCop\([\s\S]*rejectAboveCopByPlatform\.ANDROID[\s\S]*iPhone superior a \$\{formatCop\([\s\S]*rejectAboveCopByPlatform\.IPHONE/
  );
  assert.doesNotMatch(
    consoleSource,
    /Es independiente del puntaje y se aplica a ambas plataformas/
  );
  assert.doesNotMatch(consoleSource, /onEnabledChange|PriorityRuleEnabled/);

  const priorityCard = consoleSource.indexOf(
    "Regla prioritaria de rechazo por mora TELCOS"
  );
  const financialCard = consoleSource.indexOf(
    "Parámetros financieros de la política"
  );
  const androidBands = consoleSource.indexOf('platform="ANDROID"', financialCard);
  assert.ok(priorityCard >= 0);
  assert.ok(priorityCard < financialCard);
  assert.ok(financialCard < androidBands);
});

test("hace explícita la migración histórica y versiona la regla en ambos payloads", () => {
  assert.match(consoleSource, /Sin regla publicada/);
  assert.match(
    consoleSource,
    /No se activará de forma silenciosa[\s\S]*publica una nueva revisión/
  );
  assert.match(consoleSource, /Preparar regla por/);
  assert.match(consoleSource, /!priorityRulesValidation\.valid/);
  assert.match(
    consoleSource,
    /priorityRules: priorityRulesValidation\.canonical/
  );
  assert.match(
    consoleSource,
    /priorityRules: newPolicyPriorityRulesValidation\.canonical/
  );
  assert.match(
    consoleSource,
    /selectedProfile\.priorityRules \|\| DEFAULT_PRIORITY_RULES/
  );
});
