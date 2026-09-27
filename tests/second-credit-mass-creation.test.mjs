import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";

const doc = "900001";
const permission = () => ({ id: randomUUID(), documento: doc, active: true, version: 1,
  reason: "Autorización administrativa del segundo crédito", createdAt: "2026-09-27T12:00:00Z",
  updatedAt: "2026-09-27T12:00:00Z", createdByName: "Admin central", updatedByName: "Admin central" });
const credit = (id, changes = {}) => ({ id, folio: `FC-${id}`, clienteDocumento: doc,
  montoCredito: 720000, cuotaInicial: 100000, totalAbonado: 0, estado: "GENERADO", ...changes });
const request = () => ({ commit: true, sadminConfirmed: true, requestId: randomUUID() });

function fixture({ existing = [credit(1)], authorized = true, blocked = null } = {}) {
  const state = { credits: existing, authorization: authorized ? permission() : null, registrations: [], locks: [] };
  const normalize = value => String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const adapter = storage => ({
    ...catalogs,
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('FROM public."SecondCreditAuthorization"')) {
        return storage.authorization && params[0].includes(storage.authorization.documento) ? [storage.authorization] : [];
      }
      if (sql.includes('COALESCE(p."totalAbonado"')) {
        return storage.credits.filter(item => item.estado !== "ANULADO" && params[0].includes(normalize(item.clienteDocumento)))
          .map(item => ({ ...item, documento: normalize(item.clienteDocumento), totalAbonado: item.totalAbonado ?? 0, abonosCount: 0 }));
      }
      if (sql.includes('AS "requestHash"')) return storage.credits.filter(item => item.contratoSnapshot?.origen.requestId === params[0])
        .map(item => ({ id: item.id, folio: item.folio, row: item.contratoSnapshot.origen.importReceipt,
          requestHash: item.contratoSnapshot.origen.requestHash, batchId: item.contratoSnapshot.origen.batchId }));
      if (sql.includes("AS documento")) return storage.credits.filter(item => params[0].includes(normalize(item.clienteDocumento)))
        .map(item => ({ documento: normalize(item.clienteDocumento), folio: item.folio }));
      if (sql.includes("AS numero")) return storage.registrations.filter(item => params[0].includes(item.numero.toLowerCase()));
      if (sql.includes('INSERT INTO "CreditSadminRegistration"')) {
        storage.registrations.push({ numero: params[1] }); return [{ creditoId: params[0] }];
      }
      return [];
    },
    $executeRawUnsafe: async (_sql, key) => { if (typeof key === "string" && key.startsWith("DOCUMENT_BLACKLIST:")) state.locks.push(key); return 1; },
    credito: {
      findMany: async () => [], findUnique: async () => null,
      create: async ({ data }) => {
        assert.ok(state.locks.includes(`DOCUMENT_BLACKLIST:${data.clienteDocumento}`));
        const item = { ...data, id: Math.max(0, ...storage.credits.map(row => row.id)) + 1 };
        storage.credits.push(item); return { id: item.id, folio: item.folio };
      },
    },
  });
  const db = adapter(state);
  let tail = Promise.resolve();
  db.$transaction = async work => {
    const previous = tail; let release;
    tail = new Promise(resolve => { release = resolve; }); await previous;
    const staged = { ...state, credits: [...state.credits], registrations: [...state.registrations] };
    try { const result = await work(adapter(staged)); state.credits = staged.credits; state.registrations = staged.registrations; return result; }
    finally { release(); }
  };
  return { state, route: routeFixture(db, { blocked }) };
}

test("CSV reports missing authorization by row and ignores an invented permission in file data", async () => {
  const { route, state } = fixture({ authorized: false });
  const rows = [sample(2, { cedula: doc, secondCreditAuthorized: true }), sample(3)];
  const preview = await call(route, rows);
  assert.equal(preview.data.summary.invalid, 1); assert.equal(preview.data.rows[1].ok, true);
  assert.match(preview.data.rows[0].errors.join(" "), /autorización del administrador/);
  assert.equal((await call(route, rows, request())).data.commit, false); assert.equal(state.credits.length, 1);
});

test("CSV and individual create an authorized second credit, preserve amounts and retain its audit on replay", async () => {
  for (const rows of [[sample(2, { cedula: doc }), sample(3)], [sample(2, { cedula: doc })]]) {
    const { route, state } = fixture(); const mutation = request();
    assert.equal((await call(route, rows)).data.summary.invalid, 0);
    const response = await call(route, rows, mutation); assert.equal(response.data.created, rows.length);
    const saved = state.credits.find(item => item.contratoSnapshot?.origen.importReceipt.normalized.cedula === doc);
    assert.equal(saved.montoCredito, 720000); assert.equal(saved.valorCuota, 60000); assert.equal(saved.saldoBaseFinanciado, 600000);
    const audit = saved.contratoSnapshot.origen.segundoCreditoAutorizacion;
    assert.equal(audit.id, state.authorization.id); assert.equal(audit.version, 1); assert.deepEqual([...audit.activeCreditIds], [1]);
    assert.equal(audit.authorizedByName, "Admin central"); assert.equal(saved.contratoSnapshot.origen.importReceipt.ok, true);
    state.authorization = { ...state.authorization, active: false, version: 2 };
    assert.deepEqual((await call(route, rows, mutation)).data, response.data); assert.equal(state.credits.length, rows.length + 1);
  }
});

test("a revoked authorization or a second existing debt invalidates an earlier valid preview before commit", async () => {
  for (const change of [state => { state.authorization.active = false; }, state => { state.credits.push(credit(2)); }]) {
    const { route, state } = fixture(); const rows = [sample(3, { cedula: doc })];
    assert.equal((await call(route, rows)).data.summary.valid, 1); change(state);
    const before = state.credits.length;
    const response = await call(route, rows, request()); assert.equal(response.data.commit, false);
    assert.equal(response.data.summary.invalid, 1); assert.equal(state.credits.length, before);
  }
});

test("authorization never waives duplicate cédulas, duplicate SADMIN numbers, blacklist or the two-active limit", async () => {
  const { route } = fixture();
  const repeated = await call(route, [sample(2, { cedula: doc }), sample(3, { cedula: doc })]);
  assert.equal(repeated.data.summary.invalid, 2); assert.ok(repeated.data.rows.every(row => row.errors.some(error => /Cédula repetida/.test(error))));
  const numbers = await call(route, [sample(2, { cedula: doc, numeroCreditoSadmin: "DUP" }), sample(3, { numeroCreditoSadmin: "dup" })]);
  assert.equal(numbers.data.summary.invalid, 2);
  const blocked = fixture({ blocked: doc });
  assert.match((await call(blocked.route, [sample(2, { cedula: doc })])).data.rows[0].errors.join(" "), /bloqueada/);
  const full = fixture({ existing: [credit(1), credit(2)] });
  assert.match((await call(full.route, [sample(3, { cedula: doc })])).data.rows[0].errors.join(" "), /dos créditos vigentes/);
});

test("the historical CSV duplicate rule stays intact without authorization even for settled or cancelled records", async () => {
  for (const existing of [[credit(1, { totalAbonado: 720000 })], [credit(1, { estado: "ANULADO" })]]) {
    const { route } = fixture({ existing, authorized: false });
    assert.equal((await call(route, [sample(2, { cedula: doc })])).data.summary.invalid, 1);
    const allowed = fixture({ existing });
    assert.equal((await call(allowed.route, [sample(2, { cedula: doc })])).data.summary.valid, 1);
  }
});

test("simultaneous imported requests recheck the document limit and create only the second", async () => {
  const { route, state } = fixture();
  const responses = await Promise.all([call(route, [sample(2, { cedula: doc })], request()), call(route, [sample(3, { cedula: doc })], request())]);
  assert.equal(responses.filter(item => item.data.commit).length, 1); assert.equal(state.credits.length, 2);
  assert.match(responses.find(item => !item.data.commit).data.rows[0].errors.join(" "), /dos créditos vigentes/);
});
