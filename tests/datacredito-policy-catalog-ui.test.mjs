import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const consoleSource = await readFile(
  new URL(
    "../app/dashboard/parametros-credito/datacredito-policy-console.tsx",
    import.meta.url
  ),
  "utf8"
);

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
