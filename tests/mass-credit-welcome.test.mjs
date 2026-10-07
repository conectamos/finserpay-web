import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";

// Exercise the real route, validations and commit/replay branches with a local
// transactional store. The welcome sender is a spy: no database or WhatsApp is used.
function fixture({ failRegistration = false, senderResult = "sent" } = {}) {
  const state = { credits: [], registrations: [], audits: [], inTransaction: false, sends: [] };
  const adapter = storage => ({
    ...catalogs,
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('AS "requestHash"')) {
        return storage.credits.filter(credit => credit.contratoSnapshot.origen.requestId === params[0])
          .map(credit => ({ id: credit.id, folio: credit.folio,
            row: credit.contratoSnapshot.origen.importReceipt,
            requestHash: credit.contratoSnapshot.origen.requestHash,
            batchId: credit.contratoSnapshot.origen.batchId }));
      }
      if (sql.includes("AS documento")) {
        return storage.credits.filter(credit => params[0].includes(credit.clienteDocumento))
          .map(credit => ({ documento: credit.clienteDocumento, folio: credit.folio }));
      }
      if (sql.includes("AS numero")) {
        return storage.registrations.filter(item => params[0].includes(item.numero.toLowerCase()))
          .map(item => ({ numero: item.numero.toLowerCase() }));
      }
      if (sql.includes('INSERT INTO "CreditSadminRegistration"')) {
        if (failRegistration) throw new Error("Synthetic SADMIN registration failure");
        storage.registrations.push({ creditoId: params[0], numero: params[1] });
        return [{ creditoId: params[0] }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql, ...params) => {
      if (sql.includes('INSERT INTO "CreditSadminEvent"')) storage.audits.push({ creditoId: params[1] });
      return 1;
    },
    credito: {
      findMany: async ({ where }) => storage.credits.filter(credit => where.OR[0].imei.in.includes(credit.imei))
        .map(credit => ({ folio: credit.folio, imei: credit.imei, deviceUid: credit.deviceUid })),
      findUnique: async ({ where }) => storage.credits.find(credit => credit.folio === where.folio) ?? null,
      create: async ({ data }) => {
        const credit = { ...data, id: storage.credits.length + 1 };
        storage.credits.push(credit);
        return { id: credit.id, folio: credit.folio };
      },
    },
  });
  const db = adapter(state);
  db.$transaction = async work => {
    const staged = { credits: [...state.credits], registrations: [...state.registrations], audits: [...state.audits] };
    state.inTransaction = true;
    try {
      const result = await work(adapter(staged));
      state.credits = staged.credits;
      state.registrations = staged.registrations;
      state.audits = staged.audits;
      return result;
    } finally {
      state.inTransaction = false;
    }
  };
  const route = routeFixture(db, { sendDaptaWelcome: async credit => {
    assert.equal(state.inTransaction, false, "Welcome must run after the transaction finishes");
    assert.ok(state.credits.some(saved => saved.id === credit.creditId), "Credit must already be committed");
    state.sends.push(JSON.parse(JSON.stringify(credit)));
    return senderResult;
  } });
  return { state, route };
}

const confirmation = changes => ({ commit: true, sadminConfirmed: true, requestId: randomUUID(), ...changes });

test("new individual credit requests a welcome after commit with its saved phone and name", async () => {
  const { route, state } = fixture();
  const row = sample(1, { telefono: "300 000 0042", cliente: "ANA PEREZ" });
  const result = await call(route, [row], confirmation({ welcomeOnCreate: true }));
  assert.equal(result.status, 200);
  assert.equal(result.data.commit, true);
  assert.equal(result.data.created, 1);
  assert.equal(state.credits.length, 1);
  assert.equal(state.registrations.length, 1);
  assert.equal(state.audits.length, 1);
  assert.deepEqual(state.sends, [{ creditId: state.credits[0].id,
    phone: state.credits[0].clienteTelefono, name: state.credits[0].clienteNombre }]);
});

test("individual pending-SADMIN creation sends only after the credit is committed in FINSER PAY", async () => {
  const { route, state } = fixture();
  const row = sample(1, { numeroCreditoSadmin: "" });
  const result = await call(route, [row], confirmation({
    sadminMode: "PENDING", sadminConfirmed: false, welcomeOnCreate: true,
  }));
  assert.equal(result.status, 200);
  assert.equal(result.data.commit, true);
  assert.equal(result.data.rows[0].normalized.estadoSadmin, "PENDIENTE_CREACION");
  assert.equal(state.credits.length, 1);
  assert.equal(state.sends.length, 1);
});

test("replayed individual confirmation returns the original receipt without a second welcome", async () => {
  const { route, state } = fixture();
  const rows = [sample()];
  const request = confirmation({ welcomeOnCreate: true });
  const first = await call(route, rows, request);
  const replay = await call(route, rows, request);
  assert.equal(first.status, 200);
  assert.deepEqual(replay, first);
  assert.equal(state.credits.length, 1);
  assert.equal(state.sends.length, 1);
});

test("existing import requests do not send welcomes, including a historical CSV of one row", async () => {
  for (const rows of [[sample()], [sample(), sample(2)]]) {
    const { route, state } = fixture();
    const result = await call(route, rows, confirmation());
    assert.equal(result.status, 200);
    assert.equal(result.data.created, rows.length);
    assert.equal(state.sends.length, 0);
  }
});

test("welcome flag requires a boolean and cannot enable welcomes for multiple rows", async () => {
  for (const flag of [false, "true", 1]) {
    const { route, state } = fixture();
    const result = await call(route, [sample()], confirmation({ welcomeOnCreate: flag }));
    assert.equal(result.status, 200);
    assert.equal(state.sends.length, 0);
  }
  const { route, state } = fixture();
  const result = await call(route, [sample(), sample(2)], confirmation({ welcomeOnCreate: true }));
  assert.equal(result.status, 400);
  assert.equal(result.data.code, "WELCOME_INDIVIDUAL_ONLY");
  assert.equal(state.credits.length, 0);
  assert.equal(state.sends.length, 0);
});

test("preview and invalid individual creation never send a welcome", async () => {
  const { route, state } = fixture();
  const preview = await call(route, [sample()], { welcomeOnCreate: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.commit, false);
  const rejected = await call(route, [sample(1, { correo: "invalid-email" })], confirmation({ welcomeOnCreate: true }));
  assert.equal(rejected.data.commit, false);
  assert.equal(rejected.data.summary.invalid, 1);
  assert.equal(state.credits.length, 0);
  assert.equal(state.sends.length, 0);
});

test("SADMIN failure rolls back the individual credit and does not send a welcome", async () => {
  const { route, state } = fixture({ failRegistration: true });
  const result = await call(route, [sample()], confirmation({ welcomeOnCreate: true }));
  assert.equal(result.status, 500);
  assert.equal(result.data.code, "IMPORT_SAVE_FAILED");
  assert.equal(state.credits.length, 0);
  assert.equal(state.registrations.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.sends.length, 0);
});

test("failed welcome does not change credit creation or resend on confirmation replay", async () => {
  const { route, state } = fixture({ senderResult: "failed" });
  const request = confirmation({ welcomeOnCreate: true });
  const rows = [sample()];
  const result = await call(route, rows, request);
  assert.equal(result.status, 200);
  assert.equal(result.data.commit, true);
  assert.equal(result.data.created, 1);
  assert.equal(state.credits.length, 1);
  assert.deepEqual(await call(route, rows, request), result);
  assert.equal(state.sends.length, 1);
});

test("request identity cannot change whether a confirmed import requests a welcome", async () => {
  for (const firstFlag of [false, true]) {
    const { route, state } = fixture();
    const rows = [sample()];
    const request = confirmation({ welcomeOnCreate: firstFlag });
    assert.equal((await call(route, rows, request)).status, 200);
    const changed = await call(route, rows, { ...request, welcomeOnCreate: !firstFlag });
    assert.equal(changed.status, 409);
    assert.equal(changed.data.code, "IMPORT_REQUEST_CONFLICT");
    assert.equal(state.credits.length, 1);
    assert.equal(state.sends.length, firstFlag ? 1 : 0);
  }
});
