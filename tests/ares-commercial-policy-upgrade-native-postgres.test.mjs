import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { upgradeAresCommercialPolicies } from "../scripts/ares-commercial-policy-upgrade.mjs";

// Explicit opt-in only. Never reads DATABASE_URL or connects to an existing
// service: initdb creates a fresh ignored directory, on a free loopback port.
const enabled = process.env.ARES_NATIVE_PG_TEST === "1";
const binaryDirectory = process.env.ARES_NATIVE_PG_BIN || "C:\\Program Files\\PostgreSQL\\18\\bin";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generalId = "00000000-0000-4000-8000-000000000001";
const financialSettings = {
  calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66, fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
const policy = {
  financialSettings,
  bands: [{ platform: "IPHONE", installmentCount: 40, maxFinancedAmount: 3500000, initialPaymentPercentage: 20 }],
  priorityRules: { telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2000000, IPHONE: 1500000 } } },
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function command(binary, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(binaryDirectory, `${binary}${process.platform === "win32" ? ".exe" : ""}`), args, {
      cwd: root, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    // pg_ctl's server may inherit pipe handles on Windows after pg_ctl exits.
    // Wait for the utility, not for the lifetime of its detached server pipes.
    child.on("exit", (code) => {
      child.stdout.destroy();
      child.stderr.destroy();
      code === 0 ? resolve(output) : reject(new Error(`${binary} exited ${code}: ${output}`));
    });
  });
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForBlocked(observer, waitingPid, blockingPid) {
  const deadline = Date.now() + 8000;
  do {
    const row = (await observer.query("SELECT pg_blocking_pids($1) AS blockers", [waitingPid])).rows[0];
    if (row.blockers.includes(blockingPid)) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`Expected isolated backend ${waitingPid} to wait for ${blockingPid}`);
}

test("PostgreSQL nativo aislado: revisiones y asignación concurrentes no pierden cambios ni chocan versiones", {
  skip: !enabled && "Opt-in ARES_NATIVE_PG_TEST=1; se crea y detiene un clúster local nuevo, nunca se conecta a bases existentes.",
  timeout: 90000,
}, async (context) => {
  await access(path.join(binaryDirectory, process.platform === "win32" ? "initdb.exe" : "initdb"));
  const directory = await mkdtemp(path.join(root, "tmp-ares-pg-"));
  const dataDirectory = path.join(directory, "data");
  const port = await unusedPort();
  let startAttempted = false;
  const clients = [];
  const pending = [];
  const gates = [];
  try {
    await command("initdb", ["-D", dataDirectory, "--username=ares_test", "--auth-host=trust", "--auth-local=trust", "--no-locale", "--encoding=UTF8"]);
    startAttempted = true;
    await command("pg_ctl", ["-D", dataDirectory, "-l", path.join(directory, "server.log"), "-w", "-t", "20", "-o", `-h 127.0.0.1 -p ${port} -c fsync=off -c synchronous_commit=off`, "start"]);
    for (let index = 0; index < 3; index += 1) {
      const client = new pg.Client({
        host: "127.0.0.1", port, user: "ares_test", password: "", database: "postgres",
        ssl: false, options: "", application_name: `isolated_ares_test_${index}`, connectionTimeoutMillis: 5000,
      });
      await client.connect();
      clients.push(client);
      await client.query("SET statement_timeout='15s'");
      await client.query("SET lock_timeout='10s'");
    }
    const [writer, upgrade, observer] = clients;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const upgradePid = (await upgrade.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const setup = await readFile(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
    const profileSchema = setup.slice(0, setup.indexOf('ALTER TABLE "Aliado"')).replace(/^BEGIN;$/m, "");
    let schemaIndex = 0;
    const prepare = async () => {
      const schema = `ares_case_${++schemaIndex}`;
      await observer.query(`CREATE SCHEMA ${schema}`);
      for (const client of clients) await client.query(`SET search_path TO ${schema}`);
      await observer.query(profileSchema);
      await observer.query(`
        CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "dataCreditoPolicyId" UUID REFERENCES "DataCreditoPolicyProfile"("id"));
        CREATE TABLE "CreditoConfiguracion" (
          "nombre" TEXT PRIMARY KEY, "calculoVersion" TEXT, "tasaInteresEa" FLOAT,
          "fianzaTotalPorcentaje" FLOAT, "seguroCuotaPorcentaje" FLOAT, "frecuenciaPago" TEXT,
          "tasaPeriodoDecimales" INTEGER, "redondeoComercialModo" TEXT, "redondeoComercialMultiplo" INTEGER,
          "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO "CreditoConfiguracion" VALUES ('GLOBAL','ARES_FRANCES_V1',29.66,75,0.03,'QUINCENAL',6,'PISO',50,CURRENT_TIMESTAMP);
      `);
      const profileId = randomUUID();
      await observer.query('INSERT INTO "DataCreditoPolicyProfile" ("id","name","active") VALUES ($1,\'Test profile\',true)', [profileId]);
      await observer.query('INSERT INTO "DataCreditoPolicyRevision" ("id","profileId","version","policy","createdByUserId") VALUES ($1,$2,1,$3::jsonb,7)', [randomUUID(), profileId, JSON.stringify(policy)]);
      await observer.query('INSERT INTO "Aliado" VALUES (1,$1)', [generalId]);
      return profileId;
    };
    const track = (promise) => {
      // Attach a rejection handler immediately while another backend is inspected.
      promise.catch(() => undefined);
      pending.push(promise);
      return promise;
    };

    for (const general of [false, true]) {
      const profileId = general ? (await prepare(), generalId) : await prepare();
      await writer.query("BEGIN");
      if (general) await writer.query('LOCK TABLE "DataCreditoPolicy" IN EXCLUSIVE MODE');
      await writer.query('SELECT "active" FROM "DataCreditoPolicyProfile" WHERE "id"=$1 FOR UPDATE', [profileId]);
      const version = (await writer.query('SELECT "version" FROM "DataCreditoPolicyRevision" WHERE "profileId"=$1 ORDER BY "version" DESC LIMIT 1', [profileId])).rows[0].version;
      const activation = track(upgradeAresCommercialPolicies(upgrade, { actorUserId: 7, dryRun: false }));
      await waitForBlocked(observer, upgradePid, writerPid);
      const changed = { ...policy, bands: [{ ...policy.bands[0], installmentCount: 36 }] };
      await writer.query('INSERT INTO "DataCreditoPolicyRevision" ("id","profileId","version","policy","createdByUserId") VALUES ($1,$2,$3,$4::jsonb,7)', [randomUUID(), profileId, version + 1, JSON.stringify(changed)]);
      if (general) await writer.query('INSERT INTO "DataCreditoPolicy" ("version","policy","createdByUserId") VALUES ($1,$2::jsonb,7)', [version + 1, JSON.stringify(changed)]);
      await writer.query("COMMIT");
      await activation;
      const latest = (await observer.query('SELECT "version","policy" FROM "DataCreditoPolicyRevision" WHERE "profileId"=$1 ORDER BY "version" DESC LIMIT 1', [profileId])).rows[0];
      assert.equal(latest.version, version + 2);
      assert.equal(latest.policy.bands[0].installmentCount, 36);
      assert.equal(latest.policy.financialSettings.calculoVersion, "ARES_FRANCES_V2");
      context.diagnostic(`Editor ${general ? "general" : "específico"} previo: terminó; activación preservó su última revisión.`);
    }

    {
      const profileId = await prepare();
      const locked = deferred();
      const release = deferred();
      gates.push(release);
      const heldClient = {
        async query(sql, params) {
          const result = await upgrade.query(sql, params);
          if (sql.startsWith("LOCK TABLE")) { locked.resolve(); await release.promise; }
          return result;
        },
      };
      const activation = track(upgradeAresCommercialPolicies(heldClient, { actorUserId: 7, dryRun: false }));
      await locked.promise;
      // Ordinary readers are not stopped by EXCLUSIVE; editor row locking is.
      assert.equal((await observer.query('SELECT count(*)::int AS count FROM "DataCreditoPolicyRevision"')).rows[0].count, 2);
      const edit = track((async () => {
        await writer.query("BEGIN");
        await writer.query('SELECT "active" FROM "DataCreditoPolicyProfile" WHERE "id"=$1 FOR UPDATE', [profileId]);
        const current = (await writer.query('SELECT "version" FROM "DataCreditoPolicyRevision" WHERE "profileId"=$1 ORDER BY "version" DESC LIMIT 1', [profileId])).rows[0].version;
        // Same optimistic conflict check as createDataCreditoPolicyRevision.
        assert.equal(current, 2);
        assert.notEqual(current, 1, "A pre-activation expectedVersion must conflict before INSERT");
        await writer.query("ROLLBACK");
      })());
      await waitForBlocked(observer, writerPid, upgradePid);
      release.resolve();
      await Promise.all([activation, edit]);
      context.diagnostic("Editor posterior: esperó y detectó expectedVersion obsoleta sin INSERT duplicado; SELECT normales continuaron.");
    }

    {
      const profileId = await prepare();
      await writer.query("BEGIN");
      await writer.query('SELECT "active" FROM "DataCreditoPolicyProfile" WHERE "id"=$1 FOR UPDATE', [profileId]);
      await writer.query('SELECT "dataCreditoPolicyId" FROM "Aliado" WHERE "id"=1 FOR UPDATE');
      const activation = track(upgradeAresCommercialPolicies(upgrade, { actorUserId: 7, dryRun: false }));
      await waitForBlocked(observer, upgradePid, writerPid);
      await writer.query('UPDATE "Aliado" SET "dataCreditoPolicyId"=$1 WHERE "id"=1', [profileId]);
      await writer.query("COMMIT");
      await activation;
      assert.equal((await observer.query('SELECT "dataCreditoPolicyId" FROM "Aliado" WHERE "id"=1')).rows[0].dataCreditoPolicyId, profileId);
      context.diagnostic("Asignación concurrente: terminó sin deadlock y permaneció intacta.");
    }
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
    await Promise.allSettled(pending);
    await Promise.allSettled(clients.map((client) => client.end()));
    if (startAttempted) await command("pg_ctl", ["-D", dataDirectory, "-w", "-t", "20", "-m", "fast", "stop"]);
    context.diagnostic(`Clúster aislado detenido. Artefactos de prueba recuperables: ${directory}`);
  }
});
