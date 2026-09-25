import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { load, routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";
const { readImportImei } = load("lib/mass-credit-imei.ts");
const emptyDb = { ...catalogs, $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0, $transaction: async work => work(emptyDb), credito: { findMany: async () => [], create: async () => { assert.fail("Un IMEI inválido no puede crear créditos"); } } };

test("IMEI is exact text: no truncation, rounding or stripped characters", () => {
  for (const input of ["001234567890128", "490154203237518", "123456789012347", 123456789012347]) {
    const result = readImportImei(input);
    assert.equal(result.error, null); assert.equal(result.value, String(input));
  }
  assert.equal(readImportImei(" '001234567890128 ").value, "001234567890128");
  for (const input of ["1E+15", "1,23456789012345e14", "1.23456789012345E+14", "1E15", "1234567890123456", "01234567890123", "123456789012345.0", "IMEI:123456789012345", "12345678 9012345", null, {}]) {
    assert.ok(readImportImei(input).error, JSON.stringify(input));
  }
  assert.match(readImportImei("100000000000000").error, /control/);
  assert.match(readImportImei("1E+15").error, /notación científica/);
});

test("API reports every damaged IMEI before creation, retaining the original value for correction", async () => {
  const values = ["1E+15", "1.23456789012345E+14", "1234567890123456", "IMEI:123456789012345", "001234567890128"];
  const rows = values.map((imei, i) => sample(i + 1, { imei }));
  const { data } = await call(routeFixture(emptyDb), rows);
  assert.equal(data.summary.invalid, 4); assert.equal(data.summary.valid, 1);
  values.forEach((imei, i) => assert.equal(data.rows[i].normalized.imei, imei));
  assert.match(data.rows[0].errors.join(" "), /notación científica/);
  assert.match(data.rows[2].errors.join(" "), /exactamente 15/);
  const result = await call(routeFixture(emptyDb), rows, { commit: true, sadminConfirmed: true, requestId: "63493896-cb49-48fb-a2ce-ef3cb3144bbd" });
  assert.equal(result.data.commit, false); assert.equal(result.data.summary.invalid, 4);
});

test("preview rejects a 15-digit IMEI with invalid control digit before commit", async () => {
  const rows = [sample(1, { imei: "100000000000000" })];
  const preview = await call(routeFixture(emptyDb), rows);
  assert.equal(preview.data.summary.invalid, 1);
  assert.match(preview.data.rows[0].errors.join(" "), /control/);
  assert.equal(preview.data.rows[0].normalized.imei, rows[0].imei);
  const commit = await call(routeFixture(emptyDb), rows, { commit: true, sadminConfirmed: true, requestId: "63493896-cb49-48fb-a2ce-ef3cb3144bbd" });
  assert.equal(commit.data.commit, false);
  assert.equal(commit.data.summary.invalid, 1);
});

test("single creation rejects malformed IMEI and exact duplicate detection remains", async () => {
  assert.equal((await call(routeFixture(emptyDb), [sample(1, { imei: "1E+15" })])).data.summary.invalid, 1);
  const { data } = await call(routeFixture(emptyDb), [sample(1, { imei: "001234567890128" }), sample(2, { imei: "'001234567890128" })]);
  assert.equal(data.summary.invalid, 2);
  assert.ok(data.rows.every(row => row.errors.includes("IMEI repetido en la carga")));
});


test("temporary IMEI option accepts only exact 15-digit text, leaving ordinary validation strict", () => {
  assert.match(readImportImei("100000000000000").error, /control/);
  assert.equal(readImportImei("100000000000000", { allowTemporaryImei: true }).value, "100000000000000");
  assert.equal(readImportImei("100000000000000", { allowTemporaryImei: true }).error, null);
  for (const imei of ["1E+15", "1234567890123456", "12345678901234", "123456789012345.0", "IMEI:123456789012345"]) {
    assert.ok(readImportImei(imei, { allowTemporaryImei: true }).error, imei);
  }
});

test("temporary IMEI preview warns every bulk row only after explicit boolean confirmation", async () => {
  const rows = [sample(81, { imei: "100000000000000" }), sample(82, { imei: "100000000000001" })];
  const route = routeFixture(emptyDb);
  for (const temporaryImeiConfirmed of [undefined, false, "true", 1]) {
    const preview = await call(route, rows, { temporaryImeiConfirmed });
    assert.equal(preview.data.summary.invalid, 2);
    assert.ok(preview.data.rows.every(row => row.errors.some(error => /control/.test(error))));
  }
  const preview = await call(route, rows, { temporaryImeiConfirmed: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.summary.valid, 2);
  assert.equal(preview.data.summary.warnings, 2);
  assert.ok(preview.data.rows.every(row => row.ok && row.errors.length === 0));
  assert.ok(preview.data.rows.every(row => row.warnings.some(warning => /temporal.*corrección/i.test(warning))));
  assert.deepEqual(preview.data.rows.map(row => row.normalized.imei), rows.map(row => row.imei));
});

test("temporary IMEI confirmation is limited to bulk imports and never waives format or duplicate checks", async () => {
  const route = routeFixture(emptyDb);
  const individual = await call(route, [sample(81, { imei: "100000000000000" })], { temporaryImeiConfirmed: true });
  assert.equal(individual.status, 400);
  assert.equal(individual.data.code, "TEMPORARY_IMEI_BULK_ONLY");

  const rows = [
    sample(81, { imei: "100000000000000" }),
    sample(82, { imei: "'100000000000000" }),
    sample(83, { imei: "1E+15" }),
    sample(84, { imei: "1234567890123456" }),
  ];
  const preview = await call(route, rows, { temporaryImeiConfirmed: true });
  assert.equal(preview.data.summary.invalid, 4);
  assert.ok(preview.data.rows.slice(0, 2).every(row => row.errors.includes("IMEI repetido en la carga")));
  assert.match(preview.data.rows[2].errors.join(" "), /notación científica/);
  assert.match(preview.data.rows[3].errors.join(" "), /exactamente 15/);
  const committed = await call(route, rows, {
    temporaryImeiConfirmed: true, commit: true, sadminConfirmed: true, requestId: randomUUID(),
  });
  assert.equal(committed.data.commit, false);
  assert.equal(committed.data.summary.invalid, 4);
});

test("bulk temporary IMEI commit records pending-correction status, SADMIN attestation and idempotent receipts", async () => {
  const state = { credits: [], registrations: [], audits: [], locks: [] };
  const db = {
    ...catalogs,
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('INSERT INTO "CreditSadminRegistration"')) {
        state.registrations.push({ creditoId: params[0], number: params[1] });
        return [{ creditoId: params[0] }];
      }
      if (sql.includes('AS "requestHash"')) {
        return state.credits.filter(credit => credit.contratoSnapshot.origen.requestId === params[0]).map(credit => ({
          id: credit.id, folio: credit.folio,
          row: credit.contratoSnapshot.origen.importReceipt,
          requestHash: credit.contratoSnapshot.origen.requestHash,
          batchId: credit.contratoSnapshot.origen.batchId,
        }));
      }
      return [];
    },
    $executeRawUnsafe: async sql => {
      if (sql.includes('INSERT INTO "CreditSadminEvent"')) state.audits.push(sql);
      return 1;
    },
    credito: {
      findMany: async () => [], findUnique: async () => null,
      create: async ({ data }) => {
        const credit = { ...data, id: state.credits.length + 1 };
        state.credits.push(credit);
        return { id: credit.id, folio: credit.folio };
      },
    },
  };
  db.$transaction = async work => work(db);
  const route = routeFixture(db, { onImeiLock: input => state.locks.push(input) });
  const rows = [sample(81, { imei: "100000000000000" }), sample(82, { imei: "100000000000001" })];
  const request = { commit: true, sadminConfirmed: true, temporaryImeiConfirmed: true, requestId: randomUUID() };
  const missingSadmin = await call(route, rows, { ...request, sadminConfirmed: false });
  assert.equal(missingSadmin.status, 400);
  assert.equal(missingSadmin.data.code, "SADMIN_CONFIRMATION_REQUIRED");
  assert.equal(state.credits.length, 0);

  const result = await call(route, rows, request);
  assert.equal(result.status, 200);
  assert.equal(result.data.commit, true);
  assert.equal(result.data.created, 2);
  assert.equal(result.data.summary.warnings, 2);
  assert.equal(state.credits.length, 2);
  assert.equal(state.registrations.length, 2);
  assert.equal(state.audits.length, 2);
  assert.equal(state.locks.length, 2);
  assert.ok(state.locks.every(lock => lock.temporaryImportImei === true));
  assert.ok(state.credits.every(credit => credit.contratoSnapshot.origen.imeiTemporalPendienteCorreccion === true));
  assert.ok(state.credits.every(credit => credit.contratoSnapshot.equipo.imeiTemporal === true));
  assert.deepEqual(state.credits.map(credit => credit.imei), rows.map(row => row.imei));
  assert.deepEqual(state.registrations.map(registration => registration.number), rows.map(row => row.numeroCreditoSadmin));

  const replay = await call(route, rows, request);
  assert.deepEqual(replay.data, result.data);
  assert.equal(state.credits.length, 2);
  assert.equal(state.registrations.length, 2);
  const changedConfirmation = await call(route, rows, { ...request, temporaryImeiConfirmed: false });
  assert.equal(changedConfirmation.status, 409);
  assert.equal(changedConfirmation.data.code, "IMPORT_REQUEST_CONFLICT");
  assert.equal(state.credits.length, 2);
});
