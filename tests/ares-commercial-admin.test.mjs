import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const policy = await jiti.import("../lib/datacredito/policy.ts");
const uiPath = "app/dashboard/parametros-credito/datacredito-policy-console.tsx";
const uiSource = readFileSync(path.join(root, uiPath), "utf8");
const sourceFile = ts.createSourceFile(uiPath, uiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pureFunctions = new Set([
  "isRecord", "readString", "readFiniteNumber", "getCorrelationId", "parseBand",
  "parseFinancialSettings", "toEditableFinancialSettings", "validateFinancialSettings",
  "parsePriorityRules", "parsePolicyProfile", "parsePolicyAlly", "parseCatalog",
]);
const selected = sourceFile.statements.filter((node) =>
  (ts.isFunctionDeclaration(node) && pureFunctions.has(node.name?.text)) ||
  (ts.isClassDeclaration(node) && node.name?.text === "PolicyRequestError") ||
  (ts.isVariableStatement(node) && node.pos < uiSource.indexOf("function isNoInformationBand"))
);
assert.equal(selected.filter(ts.isFunctionDeclaration).length, pureFunctions.size,
  "The test must exercise each real administrative parser, not a copied implementation");
const module = { exports: {} };
const extracted = selected.map((node) => node.getText(sourceFile)).join("\n") +
  "\nmodule.exports = { parseFinancialSettings, toEditableFinancialSettings, validateFinancialSettings, parseCatalog };";
const compiled = ts.transpileModule(extracted, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
runInNewContext(compiled, { ...policy, module, exports: module.exports }, { filename: uiPath });
const admin = module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));

const v2 = {
  calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24, fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
const v1 = { ...v2, calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66 };
const legacy = {
  calculoVersion: "FRANCES_V1", tasaInteresEa: 25, fianzaCuotaPorcentaje: 2.083333,
  seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
};

function catalog(defaults = v2) {
  return {
    ok: true, defaultPolicyId: "profile-current", financialDefaults: defaults,
    profiles: [v2, v1, legacy].map((financialSettings, index) => ({
      id: `profile-${index}`, name: `Policy ${index}`, description: null, active: true,
      version: index + 1, assignedAlliesCount: index === 0 ? 1 : 0,
      financialSettings, priorityRules: {
        telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2_000_000, IPHONE: 1_000_000 } },
      },
      bands: [{ id: `band-${index}`, platform: "IPHONE", scoreMin: 0, scoreMax: 950,
        decision: "APROBADO", initialPaymentPercentage: 20, suretyPercentage: 70,
        maxFinancedAmount: 3_500_000, installmentCount: 48, maxInstallmentAmount: 160_000 }],
      createdAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z",
      revisionCreatedAt: "2026-09-14T12:00:00Z",
    })),
    allies: [{ id: 1, name: "FINSER PAY", code: "FINSER", active: true,
      policyId: "profile-0", policyName: "Policy 0", dailyQueryLimit: 10,
      dailyQueriesUsed: 2, dailyQueriesRemaining: 8, dailyQuotaResetsAt: "2026-09-15T05:00:00Z" }],
    provider: { enabled: true, configured: true, productionReady: true, environment: "PRODUCTION" },
  };
}

test("el parser administrativo conserva V2 y las versiones historicas sin convertirlas", () => {
  for (const settings of [v2, v1, legacy]) {
    const original = JSON.stringify(settings);
    const parsed = admin.parseFinancialSettings(settings, "Policy test");
    assert.deepEqual(plain(parsed), settings);
    assert.equal(JSON.stringify(settings), original);
  }
  assert.equal(admin.parseFinancialSettings({ ...v2, calculoVersion: "ares_frances_v2" }, "Policy").calculoVersion,
    "ARES_FRANCES_V2");
});

test("el parser administrativo sigue rechazando versiones desconocidas y redondeo ARES invalido", () => {
  for (const invalid of [
    { ...v2, calculoVersion: "ARES_FRANCES_V3" },
    { ...v2, tasaPeriodoDecimales: 12 },
    { ...v2, redondeoComercial: { modo: "REDONDEO", multiplo: 50 } },
    { ...v2, redondeoComercial: { modo: "PISO", multiplo: 100 } },
    { ...v2, fianzaTotalPorcentaje: undefined },
  ]) assert.throws(() => admin.parseFinancialSettings(invalid, "Policy"), /invalidos|regla ARES/);
});

test("el catalogo carga defaults V2 con perfiles mixtos y preserva bandas, mora y aliados", () => {
  const payload = catalog();
  const original = JSON.stringify(payload);
  const parsed = plain(admin.parseCatalog(payload));
  assert.equal(parsed.financialDefaults.calculoVersion, "ARES_FRANCES_V2");
  assert.equal(parsed.financialDefaults.tasaInteresEa, 29.24);
  assert.deepEqual(parsed.profiles.map((profile) => profile.financialSettings.calculoVersion),
    ["ARES_FRANCES_V2", "ARES_FRANCES_V1", "FRANCES_V1"]);
  parsed.profiles.forEach((profile, index) => {
    assert.deepEqual(profile.bands, payload.profiles[index].bands);
    assert.deepEqual(profile.priorityRules, payload.profiles[index].priorityRules);
    assert.equal(profile.version, payload.profiles[index].version);
  });
  assert.deepEqual(parsed.allies, payload.allies);
  assert.equal(JSON.stringify(payload), original);
});

test("el catalogo antiguo V1 tambien carga sin exigir una migracion para leerlo", () => {
  const parsed = admin.parseCatalog(catalog(v1));
  assert.equal(parsed.financialDefaults.calculoVersion, "ARES_FRANCES_V1");
  assert.equal(parsed.financialDefaults.tasaInteresEa, 29.66);
  assert.equal(parsed.profiles[1].financialSettings.calculoVersion, "ARES_FRANCES_V1");
  assert.throws(() => admin.parseCatalog(catalog(legacy)), /no usa el motor ARES/);
});

test("editar una configuracion V2 no reemplaza su fianza por el default legado", () => {
  for (const calculoVersion of ["ARES_FRANCES_V1", "ARES_FRANCES_V2"]) {
    const editable = plain(admin.toEditableFinancialSettings({ ...v2, calculoVersion,
      fianzaTotalPorcentaje: 71 }, { ...v2, fianzaTotalPorcentaje: 85 }));
    assert.equal(editable.fianzaTotalPorcentaje, "71");
    assert.equal(editable.tasaInteresEa, "29.24");
  }
  const legacyEditable = admin.toEditableFinancialSettings(legacy, v2);
  assert.equal(legacyEditable.fianzaTotalPorcentaje, "75");
});

test("guardar la nueva revision financiera emite V2 PISO/50 y mantiene los valores elegidos", () => {
  const editable = admin.toEditableFinancialSettings(v2);
  const result = plain(admin.validateFinancialSettings(editable));
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.canonical, v2);
  const invalid = admin.validateFinancialSettings({ ...editable, tasaInteresEa: "" });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.canonical, null);
  assert.ok(invalid.issues.length > 0);
});

test("ambos editores envian V2 para configuraciones nuevas, no un literal V1", () => {
  const compatibilityEditor = readFileSync(path.join(root,
    "app/dashboard/parametros-credito/credit-parameters-console.tsx"), "utf8");
  assert.match(compatibilityEditor, /calculoVersion: "ARES_FRANCES_V2"/);
  assert.doesNotMatch(compatibilityEditor, /calculoVersion: "ARES_FRANCES_V1",/);
  assert.match(uiSource, /calculoVersion: "ARES_FRANCES_V2"/);
  assert.match(uiSource, /financialSettings: newPolicyFinancialValidation\.canonical/);
  assert.match(uiSource, /financialSettings: financialValidation\.canonical/);
});
