import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { upgradeAresCommercialPolicies } from "../scripts/ares-commercial-policy-upgrade.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const policyModule = await jiti.import("../lib/datacredito/policy.ts");
const { resolveCreditPolicyFinancialSettings } = await jiti.import("../lib/credit-policy-financial-settings.ts");
const financial = (changes = {}) => ({
  calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66,
  fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL",
  tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 }, ...changes,
});
const makeGlobal = (changes = {}) => ({
  nombre: "GLOBAL", ...financial(), redondeoComercialModo: "PISO", redondeoComercialMultiplo: 50,
  iphoneTopeCuota: 160000, iphonePlazoMaximoCuotas: 48, ...changes,
});
const makeProfile = (id, changes = {}) => ({
  profileId: id, name: `Policy ${id}`, active: true, assigned: false,
  revisionId: `${id}-revision-3`, version: 3,
  policy: {
    bands: [{ platform: "IPHONE", scoreMin: 0, scoreMax: 950, initialPaymentPercentage: 30, maxFinancedAmount: 3500000, installmentCount: 48 }],
    priorityRules: { telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2000000, IPHONE: 1000000 } } },
    financialSettings: financial(), customAudit: { preserve: true },
  }, ...changes,
});

function fakeClient(profiles, global = makeGlobal(), failOnInsert = false) {
  const state = { profiles: structuredClone(profiles), global: structuredClone(global), history: [], mirror: [] };
  const calls = [];
  let before;
  return {
    state, calls,
    async query(sql, params = []) {
      const query = sql.replace(/\s+/g, " ").trim();
      calls.push({ query, params });
      if (query === "BEGIN") { before = structuredClone(state); return { rows: [] }; }
      if (query === "ROLLBACK") { Object.assign(state, before); return { rows: [] }; }
      if (query === "COMMIT" || query.startsWith("LOCK TABLE")) return { rows: [] };
      if (query.startsWith('SELECT * FROM "CreditoConfiguracion"')) return { rows: state.global ? [structuredClone(state.global)] : [] };
      if (query.includes('FROM "DataCreditoPolicyProfile" profile')) {
        assert.match(query, /profile\."active" = TRUE OR EXISTS/);
        assert.match(query, /ally\."dataCreditoPolicyId" = profile\."id"/);
        return { rows: structuredClone(state.profiles.filter((row) => row.active || row.assigned)) };
      }
      if (query.startsWith('INSERT INTO "DataCreditoPolicyRevision"')) {
        if (failOnInsert) throw new Error("synthetic insert failure");
        const [revisionId, profileId, version, json, actor] = params;
        const profile = state.profiles.find((row) => row.profileId === profileId);
        state.history.push(structuredClone(profile));
        Object.assign(profile, { revisionId, version, policy: JSON.parse(json), actor });
        return { rows: [], rowCount: 1 };
      }
      if (query.startsWith('INSERT INTO "DataCreditoPolicy"')) { state.mirror.push(params); return { rows: [], rowCount: 1 }; }
      if (query.startsWith('UPDATE "CreditoConfiguracion"')) {
        state.global.calculoVersion = params[0]; state.global.tasaInteresEa = params[1];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in mock: ${query}`);
    },
  };
}

test("V2 se acepta; lectura histórica V1 y su prioridad financiera permanecen intactas", () => {
  assert.equal(policyModule.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS.calculoVersion, "ARES_FRANCES_V2");
  assert.equal(policyModule.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS.tasaInteresEa, 29.24);
  for (const version of ["ARES_FRANCES_V1", "ARES_FRANCES_V2"]) {
    const settings = financial({ calculoVersion: version, tasaInteresEa: version.endsWith("V2") ? 29.24 : 29.66 });
    const parsed = policyModule.parseDataCreditoPolicyFinancialSettings(settings);
    assert.deepEqual(parsed, settings);
    const resolved = resolveCreditPolicyFinancialSettings({
      globalSettings: { ...financial({ calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24 }), fianzaCuotaPorcentaje: 2 },
      policyFinancialSettings: parsed, numeroCuotas: 40,
    });
    assert.equal(resolved.calculoVersion, version);
    assert.equal(resolved.tasaInteresEa, settings.tasaInteresEa);
    assert.equal(resolved.fianzaCuotaPorcentaje, 75 / 40);
    assert.equal(resolved.fianzaModalidad, "TOTAL_CREDITO");
    assert.deepEqual(resolved.redondeoComercial, { modo: "PISO", multiplo: 50 });
  }
});

test("importar no activa nada; exige actor y dryRun es predeterminado sin INSERT/UPDATE", async () => {
  const client = fakeClient([makeProfile("active")]);
  await assert.rejects(upgradeAresCommercialPolicies(client), /actorUserId/);
  assert.equal(client.calls.length, 0);
  const original = structuredClone(client.state);
  const report = await upgradeAresCommercialPolicies(client, { actorUserId: 42 });
  assert.equal(report.dryRun, true);
  assert.equal(report.requireComplete, false);
  assert.equal(report.revisions.length, 1);
  assert.equal(report.global.status, "PLANNED");
  assert.equal(report.revisions[0].revisionId, null);
  assert.equal(client.calls.some(({ query }) => /^(INSERT|UPDATE|DELETE)/.test(query)), false);
  assert.deepEqual(client.state, original);
  assert.equal(client.calls.at(-1).query, "ROLLBACK");
});

test("agrega revisiones activas o asignadas; preserva JSON, original y otras condiciones GLOBAL", async () => {
  const active = makeProfile("active");
  const assigned = makeProfile("assigned", { active: false, assigned: true });
  const retired = makeProfile("retired", { active: false });
  const client = fakeClient([active, assigned, retired]);
  const report = await upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false });
  assert.equal(report.requireComplete, true);
  assert.deepEqual(report.revisions.map((r) => r.profileId), ["active", "assigned"]);
  for (const [index, source] of [active, assigned].entries()) {
    const expected = structuredClone(source.policy);
    expected.financialSettings.calculoVersion = "ARES_FRANCES_V2";
    expected.financialSettings.tasaInteresEa = 29.24;
    assert.deepEqual(client.state.profiles[index].policy, expected);
    assert.deepEqual(client.state.history[index], source);
    assert.equal(client.state.profiles[index].actor, 42);
    assert.equal(client.state.profiles[index].version, 4);
  }
  assert.deepEqual(client.state.profiles[2], retired);
  assert.equal(client.state.global.iphoneTopeCuota, 160000);
  assert.equal(client.state.global.fianzaTotalPorcentaje, 75);
  assert.equal(client.state.global.tasaInteresEa, 29.24);
  assert.equal(client.calls.at(-1).query, "COMMIT");
});

test("idempotencia: segunda activación no crea revisiones ni cambia GLOBAL", async () => {
  const client = fakeClient([makeProfile("active")]);
  await upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false });
  const count = client.calls.length;
  const report = await upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false });
  assert.deepEqual(report.revisions, []);
  assert.equal(report.global.status, "UNCHANGED");
  assert.equal(client.calls.slice(count).some(({ query }) => /^(INSERT|UPDATE|DELETE)/.test(query)), false);
});

test("aplicación parcial exige opt-out explícito y conserva las configuraciones custom", async () => {
  const inherited = makeProfile("inherit"); delete inherited.policy.financialSettings;
  const legacy = makeProfile("legacy"); legacy.policy.financialSettings = { calculoVersion: "FRANCES_V1", tasaInteresEa: 25, fianzaCuotaPorcentaje: 2 };
  const invalid = makeProfile("invalid"); invalid.policy.financialSettings.redondeoComercial.multiplo = 100;
  const client = fakeClient([inherited, legacy, invalid]);
  const report = await upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false, requireComplete: false });
  assert.equal(report.requireComplete, false);
  assert.equal(report.revisions.length, 1);
  assert.equal(report.skipped.length, 2);
  assert.equal(client.state.profiles[0].policy.financialSettings.fianzaTotalPorcentaje, 75);
  assert.deepEqual(client.state.profiles[1], legacy);
  assert.deepEqual(client.state.profiles[2], invalid);
});

test("GLOBAL ajeno a ARES no se toca; fallo de escritura revierte toda la transacción", async () => {
  const incompatible = fakeClient([], makeGlobal({ calculoVersion: "FRANCES_V1" }));
  const report = await upgradeAresCommercialPolicies(incompatible, { actorUserId: 42 });
  assert.equal(report.global.reason, "GLOBAL_NOT_COMPATIBLE_ARES");
  const client = fakeClient([makeProfile("active")], makeGlobal(), true);
  const original = structuredClone(client.state);
  await assert.rejects(upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false }), /synthetic insert failure/);
  assert.deepEqual(client.state, original);
  assert.equal(client.calls.at(-1).query, "ROLLBACK");
});

test("detecta fianza o seguro distintos de ARES sin aprobar V2 ni sustituir porcentajes", async () => {
  const custom = makeProfile("custom-charges");
  custom.policy.financialSettings.fianzaTotalPorcentaje = 70;
  const client = fakeClient([custom], makeGlobal({ seguroCuotaPorcentaje: 0.06 }));
  const original = structuredClone(client.state);
  const report = await upgradeAresCommercialPolicies(client, { actorUserId: 42 });
  assert.deepEqual(report.revisions, []);
  assert.equal(report.skipped[0].reason, "POLICY_ARES_CHARGES_DIFFER");
  assert.equal(report.skipped[0].observedSuretyTotalPercentage, 70);
  assert.equal(report.skipped[0].expectedSuretyTotalPercentage, 75);
  assert.equal(report.global.reason, "GLOBAL_ARES_CHARGES_DIFFER");
  assert.equal(report.global.observedInsurancePercentage, 0.06);
  assert.equal(report.global.expectedInsurancePercentage, 0.03);
  assert.deepEqual(client.state, original);
});

test("apply predeterminado revierte incluso las revisiones compatibles si un perfil se omite", async () => {
  const general = makeProfile("00000000-0000-4000-8000-000000000001");
  const custom = makeProfile("custom");
  custom.policy.financialSettings.fianzaTotalPorcentaje = 70;
  const client = fakeClient([general, custom]);
  const original = structuredClone(client.state);
  await assert.rejects(upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false }), (error) => {
    assert.equal(error.code, "ARES_POLICY_UPGRADE_INCOMPLETE");
    assert.equal(error.report.requireComplete, true);
    assert.equal(error.report.rolledBack, true);
    assert.equal(error.report.revisions.length, 1);
    assert.equal(error.report.skipped[0].reason, "POLICY_ARES_CHARGES_DIFFER");
    return true;
  });
  assert.ok(client.calls.some(({ query }) => query.startsWith('INSERT INTO "DataCreditoPolicy"')));
  assert.equal(client.calls.some(({ query }) => query === "COMMIT"), false);
  assert.deepEqual(client.state, original);
  assert.equal(client.calls.at(-1).query, "ROLLBACK");
});

test("apply predeterminado también revierte si únicamente GLOBAL es incompatible o falta", async () => {
  for (const global of [null, makeGlobal({ calculoVersion: "FRANCES_V1" }), makeGlobal({ seguroCuotaPorcentaje: 0.06 })]) {
    const client = fakeClient([makeProfile("compatible")], global);
    const original = structuredClone(client.state);
    await assert.rejects(upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false }), (error) => {
      assert.equal(error.code, "ARES_POLICY_UPGRADE_INCOMPLETE");
      assert.equal(error.report.global.status, "SKIPPED");
      assert.equal(error.report.skipped.length, 0);
      assert.equal(error.report.rolledBack, true);
      return true;
    });
    assert.deepEqual(client.state, original);
  }
});

test("perfil general mantiene espejo append-only y activador no toca consulta, crédito o firma", async () => {
  const client = fakeClient([makeProfile("00000000-0000-4000-8000-000000000001")]);
  await upgradeAresCommercialPolicies(client, { actorUserId: 42, dryRun: false });
  assert.equal(client.state.mirror.length, 1);
  for (const { query } of client.calls) {
    assert.doesNotMatch(query, /(?:UPDATE|DELETE FROM) "(?:DataCreditoPolicyRevision|DataCreditoPolicy|DataCreditoAssessment|CreditoBorrador|Credito|CreditoAmortizacion|FirmaSeguroProcess)"/);
    assert.doesNotMatch(query, /expiresAt|consumedAt|reusedFromAssessmentId/);
  }
  const predeploy = await readFile(path.join(root, "scripts", "railway-predeploy.mjs"), "utf8");
  assert.doesNotMatch(predeploy, /ares-commercial-policy-upgrade/);
});
