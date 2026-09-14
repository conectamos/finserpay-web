import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { upgradeAresCommercialPolicies } from "../scripts/ares-commercial-policy-upgrade.mjs";

// Real PostgreSQL/WASM, isolated in memory: no environment credentials, network,
// user's service or persistent database. This does not prove multi-client locks.
let PGlite;
try { ({ PGlite } = await import("@electric-sql/pglite")); } catch {}
const financialSettings = {
  calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66, fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
const policy = {
  financialSettings,
  bands: [{ platform: "IPHONE", installmentCount: 40, maxFinancedAmount: 3500000, initialPaymentPercentage: 20 }],
  priorityRules: { telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2000000, IPHONE: 1500000 } } },
  untouched: { nested: ["history", 42] },
};
const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

test("PostgreSQL aislado: espejo real, inmutabilidad, rollback, asignados e idempotencia", {
  skip: !PGlite && "Runtime local @electric-sql/pglite no disponible; no se sustituye por una conexión externa.",
}, async () => {
  const database = new PGlite();
  const client = {
    async query(sql, params = []) {
      const result = await database.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows };
    },
  };
  try {
    const setup = await readFile(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
    const profileSchema = setup.slice(0, setup.indexOf('ALTER TABLE "Aliado"')).replace(/^BEGIN;$/m, "");
    assert.match(profileSchema, /DataCreditoPolicyRevision_immutable/);
    assert.match(profileSchema, /DataCreditoPolicy_sync_profile_revision/);
    await database.exec(profileSchema);
    await database.exec(`
      CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "dataCreditoPolicyId" UUID REFERENCES "DataCreditoPolicyProfile"("id"));
      CREATE TABLE "CreditoConfiguracion" (
        "nombre" TEXT PRIMARY KEY, "calculoVersion" TEXT, "tasaInteresEa" FLOAT,
        "fianzaTotalPorcentaje" FLOAT, "seguroCuotaPorcentaje" FLOAT, "frecuenciaPago" TEXT,
        "tasaPeriodoDecimales" INTEGER, "redondeoComercialModo" TEXT, "redondeoComercialMultiplo" INTEGER,
        "iphoneTopeCuota" INTEGER, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO "CreditoConfiguracion" VALUES ('GLOBAL','ARES_FRANCES_V1',29.66,75,0.03,'QUINCENAL',6,'PISO',50,160000,CURRENT_TIMESTAMP);
      CREATE TABLE "CreditHistoryFixture" ("id" INTEGER PRIMARY KEY, "loan" JSONB, "assessment" JSONB);
      INSERT INTO "CreditHistoryFixture" VALUES (1,'{"signed":true,"rate":29.66,"installment":91033.04}', '{"reusedFromAssessmentId":null,"expiresAt":"2026-09-29","offer":{"tasaInteresEa":29.66}}');
    `);
    const addProfile = async (id, active = true, profilePolicy = policy) => {
      await database.query('INSERT INTO "DataCreditoPolicyProfile" ("id","name","active") VALUES ($1,$2,$3)', [uuid(id), `Profile ${id}`, active]);
      await database.query('INSERT INTO "DataCreditoPolicyRevision" ("id","profileId","version","policy","createdByUserId") VALUES ($1,$2,1,$3::jsonb,7)', [uuid(id + 1000), uuid(id), JSON.stringify(profilePolicy)]);
    };
    await addProfile(10);
    await addProfile(20, false);
    await addProfile(30, false);
    await database.query('INSERT INTO "Aliado" VALUES (1,$1)', [uuid(20)]);
    const originalRows = (await database.query('SELECT * FROM "DataCreditoPolicyRevision" ORDER BY "profileId","version"')).rows;
    const history = (await database.query('SELECT * FROM "CreditHistoryFixture"')).rows;
    const dry = await upgradeAresCommercialPolicies(client, { actorUserId: 7 });
    assert.equal(dry.revisions.length, 3);
    assert.deepEqual((await database.query('SELECT * FROM "DataCreditoPolicyRevision" ORDER BY "profileId","version"')).rows, originalRows);
    const report = await upgradeAresCommercialPolicies(client, { actorUserId: 7, dryRun: false });
    assert.equal(report.revisions.length, 3);
    assert.equal(report.global.status, "UPDATED");
    const current = (await database.query('SELECT * FROM "DataCreditoPolicyRevision" WHERE "profileId"=$1 ORDER BY "version"', [uuid(10)])).rows;
    assert.equal(current.length, 2);
    assert.deepEqual(current[0], originalRows.find((row) => row.profileId === uuid(10)));
    assert.deepEqual(current[1].policy, { ...policy, financialSettings: { ...financialSettings, calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24 } });
    assert.equal((await database.query('SELECT * FROM "DataCreditoPolicy"')).rows.length, 1);
    await assert.rejects(database.query('UPDATE "DataCreditoPolicyRevision" SET "policy"=\'{}\' WHERE "profileId"=$1', [uuid(10)]), /inmutables/);
    assert.deepEqual((await database.query('SELECT * FROM "CreditHistoryFixture"')).rows, history);
    assert.equal((await database.query('SELECT * FROM "CreditoConfiguracion"')).rows[0].iphoneTopeCuota, 160000);
    const second = await upgradeAresCommercialPolicies(client, { actorUserId: 7, dryRun: false });
    assert.deepEqual(second.revisions, []);
    assert.equal(second.global.status, "UNCHANGED");

    // A compatible append made before a skipped custom profile must roll back.
    await addProfile(70);
    await addProfile(80, true, { ...policy, financialSettings: { ...financialSettings, fianzaTotalPorcentaje: 70 } });
    const beforeIncomplete = (await database.query('SELECT * FROM "DataCreditoPolicyRevision" ORDER BY "profileId","version"')).rows;
    await assert.rejects(upgradeAresCommercialPolicies(client, { actorUserId: 7, dryRun: false }), (error) => {
      assert.equal(error.code, "ARES_POLICY_UPGRADE_INCOMPLETE");
      assert.equal(error.report.rolledBack, true);
      assert.equal(error.report.revisions[0].profileId, uuid(70));
      assert.equal(error.report.skipped[0].profileId, uuid(80));
      return true;
    });
    assert.deepEqual((await database.query('SELECT * FROM "DataCreditoPolicyRevision" ORDER BY "profileId","version"')).rows, beforeIncomplete);
    await database.query('UPDATE "DataCreditoPolicyProfile" SET "active"=false WHERE "id"=$1', [uuid(80)]);

    // Fail the second insert after a successful earlier insert; neither survives.
    await addProfile(90);
    await addProfile(99);
    await database.exec(`
      CREATE FUNCTION "fail_test_upgrade"() RETURNS trigger AS $$
      BEGIN
        IF NEW."profileId" = '${uuid(99)}'::uuid AND NEW."version" > 1 THEN RAISE EXCEPTION 'synthetic PostgreSQL failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "fail_test_upgrade" BEFORE INSERT ON "DataCreditoPolicyRevision" FOR EACH ROW EXECUTE FUNCTION "fail_test_upgrade"();
    `);
    const beforeFailure = (await database.query('SELECT * FROM "DataCreditoPolicyRevision" ORDER BY "profileId","version"')).rows;
    await assert.rejects(upgradeAresCommercialPolicies(client, { actorUserId: 7, dryRun: false }), /synthetic PostgreSQL failure/);
    assert.deepEqual((await database.query('SELECT * FROM "DataCreditoPolicyRevision" ORDER BY "profileId","version"')).rows, beforeFailure);
  } finally {
    await database.close();
  }
});
