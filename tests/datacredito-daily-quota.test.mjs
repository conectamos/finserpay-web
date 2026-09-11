import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { serializeDataCreditoDailyQuota } from "../lib/datacredito/daily-quota.ts";
import { canOperateSolicitud, isDirectSalesProfile } from "../lib/solicitud-operation-access.ts";

const [storage, evaluationRoute, policyRoute] = await Promise.all([
  readFile(new URL("../lib/datacredito/storage.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/creditos/datacredito/evaluaciones/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/creditos/datacredito/politica/route.ts", import.meta.url), "utf8"),
]);
const resetsAt = new Date("2026-09-11T05:00:00.000Z");

test("el porcentaje de cupo proviene del servidor y solo llega a 100 al agotarse", () => {
  for (const [limit, used, remaining, percentUsed, exhausted] of [
    [20, 0, 20, 0, false], [20, 19, 1, 95, false],
    [20, 20, 0, 100, true], [5, 8, 0, 100, true],
    [0, 0, 0, 100, true], [null, 25, null, null, false],
    [10000, 9999, 1, 99, false],
  ]) {
    assert.deepEqual(serializeDataCreditoDailyQuota({ limit, used, resetsAt }), {
      limit, used, remaining, percentUsed, exhausted, resetsAt: resetsAt.toISOString(),
    });
  }
  for (const [limit, used] of [[-1, 0], [10001, 0], [1.5, 0], [5, -1], [5, 0.5]]) {
    assert.throws(() => serializeDataCreditoDailyQuota({ limit, used, resetsAt }),
      /DATACREDITO_INVALID_DAILY_QUOTA_STATE/);
  }
});

test("el contrato separa cupo de rechazo y el GET lee solo el aliado autenticado", () => {
  const exhaustedBranch = evaluationRoute.match(
    /if \(reservation\.kind === "DAILY_QUOTA_EXHAUSTED"\)[\s\S]*?\n    }/
  )?.[0];
  assert.ok(exhaustedBranch);
  assert.match(exhaustedBranch, /code: "ALLY_DAILY_QUERY_LIMIT_REACHED"/);
  assert.match(exhaustedBranch, /status: 429/);
  assert.match(exhaustedBranch, /dailyQuota: serializeDataCreditoDailyQuota\(/);
  assert.doesNotMatch(exhaustedBranch, /RECHAZADO|solicitudTechnicalResponse/);
  assert.match(policyRoute,
    /const dailyQuota = simulationRequested\s*\? undefined\s*:\s*await getDataCreditoDailyQuotaSnapshot\(quotaAllyId\)/);
  assert.doesNotMatch(policyRoute, /getDataCreditoDailyQuotaSnapshot\(.*searchParams/);
  assert.doesNotMatch(policyRoute, /getActiveSolicitudCreditContext|expireStaleSolicitudes/);
  const reuse = storage.indexOf("const reusable = await tryReuseDataCreditoAssessment", storage.indexOf("export async function reserveDataCreditoAssessment"));
  const reserve = storage.indexOf("const dailyQuota = await reserveDataCreditoDailyQuota", reuse);
  assert.ok(reuse >= 0 && reserve > reuse, "Las consultas reutilizables se resuelven antes del cupo");
});

test("la lectura del propietario del cupo no vence solicitudes ni lee datos personales", () => {
  const ownerSource = storage.match(
    /export async function getDataCreditoQuotaSolicitudOwner[\s\S]*?(?=export async function getDataCreditoDailyQuotaSnapshot)/
  )?.[0];
  assert.ok(ownerSource);
  assert.match(ownerSource, /SELECT d\."vendedorId", s\."aliadoId"/);
  assert.match(ownerSource, /WHERE d\."id" = \$1/);
  assert.match(ownerSource, /d\."estado" = 'ABIERTO'/);
  assert.match(ownerSource, /COALESCE\(d\."expiresAt", d\."createdAt" \+ INTERVAL '15 days'\) > CURRENT_TIMESTAMP/);
  assert.doesNotMatch(ownerSource, /\bUPDATE\b|\bDELETE\b|\bINSERT\b|\$executeRaw|expireStale|ensureSolicitud/);
  assert.doesNotMatch(ownerSource, /clienteDocumento|clientePrimerApellido|imei|payload/);
});

const policyGetSource = policyRoute.match(/export async function GET[\s\S]*?(?=export async function PATCH)/)?.[0];
assert.ok(policyGetSource);
async function requestQuotaPolicy({ user, seller = null, owner = null, query = "" }) {
  const quotaReads = [];
  const policyReads = [];
  const ownerReads = [];
  const dependencies = {
    NextResponse: Response,
    getSessionUser: async () => user,
    getDataCreditoPublicConfig: () => ({ enabled: true, configured: true }),
    isCentralAdmin: (actor) => actor.central === true,
    DATA_CREDITO_INCLUDE_DISABLED_POLICY_PARAM: "includeDisabledPolicy",
    shouldLoadDataCreditoPolicy: () => true,
    normalizeDataCreditoPlatform: (platform) => ["ANDROID", "IPHONE"].includes(platform) ? platform : null,
    isAdminRole: (role) => role === "ADMIN",
    getSellerSessionUser: async () => seller,
    getDataCreditoQuotaSolicitudOwner: async (id) => { ownerReads.push(id); return owner; },
    canOperateSolicitud,
    isDirectSalesProfile,
    getAssignedDataCreditoPolicy: async (id) => {
      policyReads.push(id);
      return { kind: "READY", policy: { version: 1, revisionId: "test-policy" } };
    },
    getDataCreditoDailyQuotaSnapshot: async (id) => {
      quotaReads.push(id);
      return serializeDataCreditoDailyQuota({ limit: 5, used: 5, resetsAt });
    },
    resolveDataCreditoDecision: () => ({ decision: "APROBADO", offer: {} }),
    DATACREDITO_NO_INFORMATION_SCORE: -1,
    serializePolicyResponse: (input) => ({ ok: true, ...input }),
    DataCreditoStorageConfigurationError: class extends Error {},
  };
  const get = new Function(...Object.keys(dependencies),
    `${stripTypeScriptTypes(policyGetSource.replace("export async", "async"))}; return GET;`
  )(...Object.values(dependencies));
  const response = await get(new Request(`https://finserpay.test/api/creditos/datacredito/politica${query}`));
  return { status: response.status, body: await response.json(), quotaReads, policyReads, ownerReads };
}

test("GET cuota: autenticacion, propietario autorizado y aislamiento entre aliados", async () => {
  const central = { id: 1, aliadoId: 1, rolNombre: "ADMIN", central: true };
  const allyUser = { id: 2, aliadoId: 2, rolNombre: "ALIADO" };
  const owner = { aliadoId: 2, vendedorId: 7 };
  const seller = { id: 7, tipoPerfil: "VENDEDOR" };
  const anonymous = await requestQuotaPolicy({ user: null, owner, query: "?solicitudId=100" });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.quotaReads, []);
  const crossAllyCentral = await requestQuotaPolicy({ user: central, owner, query: "?solicitudId=100" });
  assert.equal(crossAllyCentral.status, 200);
  assert.deepEqual(crossAllyCentral.ownerReads, [100], "Resuelve solamente el propietario solicitado");
  assert.deepEqual(crossAllyCentral.quotaReads, [2], "El central lee el cupo del propietario que reserva POST");
  assert.deepEqual(crossAllyCentral.policyReads, [1], "La asignacion de politica existente no cambia");
  const ownRequest = await requestQuotaPolicy({ user: allyUser, seller, owner, query: "?solicitudId=100" });
  assert.equal(ownRequest.status, 200);
  assert.deepEqual(ownRequest.quotaReads, [2]);
  for (const input of [
    { user: { ...allyUser, aliadoId: 3 }, seller, owner },
    { user: allyUser, seller: { ...seller, id: 8 }, owner },
    { user: allyUser, seller: null, owner },
    { user: allyUser, seller, owner: null },
    { user: { ...allyUser, rolNombre: "ADMIN" }, seller, owner },
  ]) {
    const denied = await requestQuotaPolicy({ ...input, query: "?solicitudId=100" });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.quotaReads, [], "Un alcance no autorizado nunca lee el cupo ajeno");
  }
  for (const id of ["", "0", "-1", "1.5", "NaN"]) {
    const invalid = await requestQuotaPolicy({ user: central, owner, query: `?solicitudId=${id}` });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.quotaReads, []);
  }
  const normal = await requestQuotaPolicy({ user: allyUser, query: "?aliadoId=999" });
  assert.equal(normal.status, 200);
  assert.deepEqual(normal.quotaReads, [2], "El alta nueva solo lee su propio aliado y no acepta un aliado arbitrario");
  const simulation = await requestQuotaPolicy({ user: allyUser, query: "?purpose=simulation&platform=ANDROID&solicitudId=100" });
  assert.equal(simulation.status, 200);
  assert.deepEqual(simulation.quotaReads, []);
  assert.deepEqual(simulation.ownerReads, []);
  assert.equal(simulation.body.dailyQuota, undefined);
});

// Execute the production reservation/read functions with a PostgreSQL adapter.
// Injecting only the SQL clock makes the midnight boundary deterministic.
const reservationSource = storage.match(
  /async function reserveDataCreditoDailyQuota[\s\S]*?(?=async function insertPendingDataCreditoAssessment)/
)?.[0];
const snapshotSource = storage.match(
  /export async function getDataCreditoDailyQuotaSnapshot[\s\S]*?(?=type DataCreditoDailyQuotaState)/
)?.[0];
assert.ok(reservationSource && snapshotSource);
const reserveQuota = new Function("DataCreditoStorageConfigurationError", "schemaNotReady",
  `${stripTypeScriptTypes(reservationSource)}; return reserveDataCreditoDailyQuota;`
)(Error, () => new Error("SCHEMA_NOT_READY"));
function snapshotFor(database) {
  return new Function("prisma", "ensureDataCreditoSchema", "serializeDataCreditoDailyQuota",
    `${stripTypeScriptTypes(snapshotSource.replace("export async", "async"))}; return getDataCreditoDailyQuotaSnapshot;`
  )(database, async () => {}, serializeDataCreditoDailyQuota);
}

const connectionString = process.env.DATACREDITO_QUOTA_TEST_DATABASE_URL;
test("PostgreSQL: ultimo cupo concurrente, aliados y reinicio Bogota en cambios de calendario", {
  skip: connectionString ? false : "Requiere DATACREDITO_QUOTA_TEST_DATABASE_URL de una base PostgreSQL local aislada.",
}, async () => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Solo PostgreSQL local");
  assert.equal(url.pathname, "/finserpay_quota_isolated_test", "Solo la base aislada de pruebas");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 24, connectionTimeoutMillis: 5000 });
  const schema = `quota_test_${randomUUID().replaceAll("-", "")}`;
  const admin = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path = "${schema}"`);
    await admin.query(`CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "dataCreditoDailyQueryLimit" INTEGER);
      CREATE TABLE "DataCreditoDailyQuotaUsage" (
        "allyId" INTEGER NOT NULL REFERENCES "Aliado"("id"), "businessDate" DATE NOT NULL,
        "usedCount" INTEGER NOT NULL CHECK ("usedCount" >= 0),
        "createdAt" TIMESTAMP NOT NULL, "updatedAt" TIMESTAMP NOT NULL,
        PRIMARY KEY ("allyId", "businessDate")
      );
      INSERT INTO "Aliado" VALUES (1, 2), (2, 5), (3, 0), (4, NULL), (5, 1)`);
    const adapter = (client, now) => ({
      $queryRawUnsafe: async (sql, ...values) => {
        const query = now && sql.includes("clock_timestamp()")
          ? { text: sql.replaceAll("clock_timestamp()", `$${values.length + 1}::timestamptz`), values: [...values, now] }
          : { text: sql, values };
        return (await client.query(query)).rows;
      },
    });
    const reserve = async (allyId, now = "2026-09-10T12:00:00Z", rollback = false) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path = "${schema}"`);
        const result = await reserveQuota(allyId, adapter(client, now));
        await client.query(rollback ? "ROLLBACK" : "COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const snapshot = (allyId, now = "2026-09-10T12:00:00Z") =>
      snapshotFor(adapter(admin, now))(allyId);

    assert.equal((await snapshot(1)).used, 0);
    assert.equal((await reserve(1)).remaining, 1);
    const race = await Promise.all(Array.from({ length: 20 }, () => reserve(1)));
    assert.equal(race.filter((result) => result.allowed).length, 1, "Solo un asesor obtiene el ultimo cupo");
    assert.equal(race.filter((result) => !result.allowed).length, 19);
    assert.equal((await snapshot(1)).used, 2, "Las solicitudes simultaneas nunca exceden el limite");
    assert.equal((await reserve(1)).allowed, false, "El servidor sigue rechazando nuevas reservas");
    assert.equal((await snapshot(1)).percentUsed, 100);
    assert.equal((await snapshot(1)).exhausted, true);
    const otherAlly = await reserve(2);
    assert.equal(otherAlly.allowed, true, "Otro aliado conserva su propio cupo");
    assert.equal(otherAlly.remaining, 4);
    assert.equal((await reserve(3)).allowed, false, "Cupo cero bloquea sin incrementar");
    assert.equal((await snapshot(3)).used, 0);
    assert.equal((await snapshot(3)).exhausted, true);
    const unlimited = await Promise.all(Array.from({ length: 7 }, () => reserve(4)));
    assert.equal(unlimited.filter((result) => result.allowed).length, 7);
    assert.equal((await snapshot(4)).exhausted, false);
    assert.equal((await snapshot(4)).percentUsed, null);

    const beforeMidnight = "2026-09-10T04:59:59.999Z";
    const midnight = "2026-09-10T05:00:00.000Z";
    const previousDay = await reserve(5, beforeMidnight);
    assert.equal(previousDay.businessDate, "2026-09-09");
    assert.equal(previousDay.resetsAt.toISOString(), midnight);
    assert.equal((await reserve(5, beforeMidnight)).allowed, false);
    assert.equal((await snapshot(5, beforeMidnight)).exhausted, true);
    assert.equal((await snapshot(5, midnight)).used, 0, "El GET refleja el dia nuevo sin consumir");
    const newDay = await reserve(5, midnight);
    assert.equal(newDay.allowed, true);
    assert.equal(newDay.businessDate, "2026-09-10");
    assert.equal(newDay.resetsAt.toISOString(), resetsAt.toISOString());
    assert.equal((await reserve(5, midnight)).allowed, false);

    const calendarCases = [
      [10, "fin de mes", "2026-09-30", "2026-10-01", "2026-10-02"],
      [11, "fin de ano", "2026-12-31", "2027-01-01", "2027-01-02"],
      [12, "febrero no bisiesto", "2027-02-28", "2027-03-01", "2027-03-02"],
      [13, "entrada al dia bisiesto", "2028-02-28", "2028-02-29", "2028-03-01"],
      [14, "salida del dia bisiesto", "2028-02-29", "2028-03-01", "2028-03-02"],
    ];
    for (const [allyId, label, oldDate, newDate, followingDate] of calendarCases) {
      await admin.query('INSERT INTO "Aliado" VALUES ($1, 1)', [allyId]);
      const beforeUtcMidnight = `${oldDate}T23:59:59.999Z`;
      const utcMidnight = `${newDate}T00:00:00.000Z`;
      const beforeBogotaMidnight = `${newDate}T04:59:59.999Z`;
      const bogotaMidnight = `${newDate}T05:00:00.000Z`;
      const nextReset = `${followingDate}T05:00:00.000Z`;
      const firstReservation = await reserve(allyId, beforeUtcMidnight);
      assert.equal(firstReservation.allowed, true, label);
      assert.equal(firstReservation.businessDate, oldDate, label);
      assert.equal(firstReservation.resetsAt.toISOString(), bogotaMidnight, label);
      for (const instant of [utcMidnight, beforeBogotaMidnight]) {
        assert.equal((await reserve(allyId, instant)).allowed, false,
          `${label}: cambiar de fecha UTC no libera el cupo del dia colombiano`);
        const blocked = await snapshot(allyId, instant);
        assert.equal(blocked.exhausted, true, label);
        assert.equal(blocked.used, 1, label);
        assert.equal(blocked.resetsAt, bogotaMidnight, label);
      }
      const reopened = await snapshot(allyId, bogotaMidnight);
      assert.equal(reopened.exhausted, false, `${label}: el GET refleja el cambio exacto a medianoche`);
      assert.equal(reopened.used, 0, `${label}: leer no consume el cupo del nuevo dia`);
      assert.equal(reopened.remaining, 1, label);
      assert.equal(reopened.resetsAt, nextReset, label);
      const nextReservation = await reserve(allyId, bogotaMidnight);
      assert.equal(nextReservation.allowed, true, label);
      assert.equal(nextReservation.businessDate, newDate, label);
      assert.equal(nextReservation.resetsAt.toISOString(), nextReset, label);
      assert.equal((await reserve(allyId, bogotaMidnight)).allowed, false,
        `${label}: el dia nuevo mantiene el bloqueo despues de consumir su limite`);
      const calendarUsage = await admin.query(`
        SELECT "businessDate"::text AS "date", "usedCount" AS "used"
        FROM "DataCreditoDailyQuotaUsage" WHERE "allyId" = $1 ORDER BY "businessDate"
      `, [allyId]);
      assert.deepEqual(calendarUsage.rows, [{ date: oldDate, used: 1 }, { date: newDate, used: 1 }],
        `${label}: el reinicio conserva el contador del dia anterior`);
    }

    await admin.query('UPDATE "Aliado" SET "dataCreditoDailyQueryLimit" = 3 WHERE "id" = 1');
    assert.equal((await snapshot(1)).exhausted, false, "La lectura reconoce ampliaciones administrativas");
    await reserve(1, "2026-09-10T12:00:00Z", true);
    assert.equal((await snapshot(1)).used, 2, "Un rollback local conserva el cupo");
    assert.equal((await reserve(1)).allowed, true);
    assert.equal((await reserve(1)).allowed, false);
    const beforeReads = (await admin.query('SELECT * FROM "DataCreditoDailyQuotaUsage" ORDER BY "allyId", "businessDate"')).rows;
    await snapshot(1);
    await snapshot(2);
    assert.deepEqual((await admin.query('SELECT * FROM "DataCreditoDailyQuotaUsage" ORDER BY "allyId", "businessDate"')).rows,
      beforeReads, "Las lecturas de estado no consumen ni cambian consultas");
  } finally {
    // The identifier is generated locally and only this dedicated test schema is removed.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    admin.release();
    await pool.end();
  }
});
