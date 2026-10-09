import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";

// Exercise the real route, validations and commit/replay branches with a local
// transactional store. The welcome sender is a spy: no database or WhatsApp is used.
function fixture({ failRegistration = false, senderResult = "sent", voiceEnabled = false, failAfterEnqueue = false,
  failVoiceDispatch = false, failSchedule = false, enqueueResult = true } = {}) {
  const state = { credits: [], registrations: [], audits: [], inTransaction: false, sends: [],
    voiceEvents: [], voiceAttempts: [], ensureCalls: 0, activeTransaction: null, afterCallbacks: [], voiceDispatches: [] };
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
    const staged = { credits: [...state.credits], registrations: [...state.registrations], audits: [...state.audits],
      voiceEvents: [...state.voiceEvents] };
    state.inTransaction = true;
    const transaction = adapter(staged);
    state.activeTransaction = { transaction, staged };
    try {
      const result = await work(transaction);
      if (failAfterEnqueue) throw new Error("Synthetic commit failure after voice enqueue");
      state.credits = staged.credits;
      state.registrations = staged.registrations;
      state.audits = staged.audits;
      state.voiceEvents = staged.voiceEvents;
      return result;
    } finally {
      state.inTransaction = false;
      state.activeTransaction = null;
    }
  };
  const route = routeFixture(db, {
    env: voiceEnabled ? { DAPTA_WELCOME_VOICE_ENABLED: "true" } : {},
    after: callback => {
      assert.equal(state.inTransaction, false, "Voice work is registered only after commit");
      assert.ok(state.voiceEvents.length, "Committed outbox event must exist before scheduling");
      if (failSchedule) throw new Error("Synthetic scheduling error");
      state.afterCallbacks.push(callback);
    },
    dispatchCreditWelcomeVoice: async options => {
      assert.equal(state.inTransaction, false);
      assert.ok(state.credits.length && state.voiceEvents.length);
      state.voiceDispatches.push({ ...options });
      if (failVoiceDispatch) throw new Error("Synthetic private provider error");
      return { accepted: 1 };
    },
    ensureCreditWelcomeVoiceSchema: async () => {
      assert.equal(state.inTransaction, false, "Schema preparation happens before the credit transaction");
      state.ensureCalls++;
    },
    enqueueCreditWelcomeVoice: async (transaction, input) => {
      if (!voiceEnabled || !enqueueResult) return null;
      assert.equal(state.inTransaction, true, "Voice outbox must enqueue inside the credit transaction");
      assert.equal(transaction, state.activeTransaction.transaction, "Voice uses the same transaction as credit creation");
      const credit = state.activeTransaction.staged.credits.find(saved => saved.id === input.creditId);
      assert.ok(credit, "The credit must exist in the staged transaction");
      assert.equal(input.source, "INDIVIDUAL_IMPORT");
      state.voiceAttempts.push({ ...input, phone: credit.clienteTelefono, name: credit.clienteNombre });
      const event = { eventId: randomUUID(), ...input, phone: credit.clienteTelefono, name: credit.clienteNombre };
      state.activeTransaction.staged.voiceEvents.push(event);
      return { eventId: event.eventId };
    },
    sendDaptaWelcome: async credit => {
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

test("voice outbox enqueues only the new individual credit inside its transaction using saved contact", async () => {
  const { route, state } = fixture({ voiceEnabled: true });
  const row = sample(1, { telefono: "300 000 0042", cliente: "ANA PEREZ" });
  const result = await call(route, [row], confirmation({ welcomeOnCreate: true }));
  assert.equal(result.status, 200);
  assert.equal(result.data.commit, true);
  assert.equal(state.ensureCalls, 1);
  assert.equal(state.voiceEvents.length, 1);
  const event = state.voiceEvents[0], credit = state.credits[0];
  assert.equal(event.creditId, credit.id);
  assert.equal(event.phone, credit.clienteTelefono);
  assert.equal(event.name, credit.clienteNombre);
  assert.equal(event.source, "INDIVIDUAL_IMPORT");
  assert.deepEqual(state.sends, [{ creditId: event.creditId, phone: event.phone, name: event.name }]);
});

test("voice replay returns the same credit without another enqueue", async () => {
  const { route, state } = fixture({ voiceEnabled: true });
  const request = confirmation({ welcomeOnCreate: true });
  const rows = [sample()];
  const first = await call(route, rows, request);
  assert.equal(first.status, 200);
  assert.deepEqual(await call(route, rows, request), first);
  assert.equal(state.credits.length, 1);
  assert.equal(state.voiceAttempts.length, 1);
  assert.equal(state.voiceEvents.length, 1);
});

test("historical single-row and bulk imports do not enqueue voice events with feature enabled", async () => {
  for (const rows of [[sample()], [sample(), sample(2)]]) {
    const { route, state } = fixture({ voiceEnabled: true });
    const result = await call(route, rows, confirmation());
    assert.equal(result.status, 200);
    assert.equal(result.data.created, rows.length);
    assert.equal(state.voiceEvents.length, 0);
    assert.equal(state.voiceAttempts.length, 0);
    assert.equal(state.ensureCalls, 0);
  }
});

test("voice flag is strict: preview, invalid rows, nonboolean flag and disabled feature do not enqueue", async () => {
  for (const flag of [false, "true", 1]) {
    const { route, state } = fixture({ voiceEnabled: true });
    const result = await call(route, [sample()], confirmation({ welcomeOnCreate: flag }));
    assert.equal(result.status, 200);
    assert.equal(state.voiceEvents.length, 0);
  }
  const { route, state } = fixture({ voiceEnabled: true });
  await call(route, [sample()], { welcomeOnCreate: true });
  assert.equal(state.ensureCalls, 0);
  await call(route, [sample(1, { correo: "invalid-email" })], confirmation({ welcomeOnCreate: true }));
  assert.equal(state.voiceAttempts.length, 0);
  assert.equal(state.voiceEvents.length, 0);
  const disabled = fixture();
  assert.equal((await call(disabled.route, [sample()], confirmation({ welcomeOnCreate: true }))).status, 200);
  assert.equal(disabled.state.ensureCalls, 0);
  assert.equal(disabled.state.voiceEvents.length, 0);
});

test("SADMIN failure prevents enqueue and a later commit failure rolls back credit plus outbox", async () => {
  const registrationFailure = fixture({ voiceEnabled: true, failRegistration: true });
  assert.equal((await call(registrationFailure.route, [sample()], confirmation({ welcomeOnCreate: true }))).status, 500);
  assert.equal(registrationFailure.state.voiceAttempts.length, 0);
  assert.equal(registrationFailure.state.voiceEvents.length, 0);
  const commitFailure = fixture({ voiceEnabled: true, failAfterEnqueue: true });
  assert.equal((await call(commitFailure.route, [sample()], confirmation({ welcomeOnCreate: true }))).status, 500);
  assert.equal(commitFailure.state.voiceAttempts.length, 1, "Hook executed before injected commit failure");
  assert.equal(commitFailure.state.credits.length, 0);
  assert.equal(commitFailure.state.voiceEvents.length, 0, "Outbox rolls back with credit transaction");
  assert.equal(commitFailure.state.sends.length, 0);
  assert.equal(commitFailure.state.afterCallbacks.length, 0);
});

test("a committed voice event wakes the bounded dispatcher only after the response, once per new credit", async () => {
  const f = fixture({ voiceEnabled: true });
  const request = confirmation({ welcomeOnCreate: true });
  const first = await call(f.route, [sample()], request);
  assert.equal(first.status, 200);
  assert.equal(f.state.afterCallbacks.length, 1);
  assert.equal(f.state.voiceDispatches.length, 0, "HTTP response does not await the provider");
  await f.state.afterCallbacks[0]();
  assert.deepEqual(f.state.voiceDispatches, [{ limit: 5 }]);
  assert.deepEqual(await call(f.route, [sample()], request), first);
  assert.equal(f.state.afterCallbacks.length, 1, "Confirmation replay must not schedule again");
});

test("voice dispatch and scheduling failures cannot change a committed import response", async () => {
  for (const failure of [{ failVoiceDispatch: true }, { failSchedule: true }]) {
    const f = fixture({ voiceEnabled: true, ...failure });
    const response = await call(f.route, [sample()], confirmation({ welcomeOnCreate: true }));
    assert.equal(response.status, 200);
    assert.equal(response.data.created, 1);
    for (const callback of f.state.afterCallbacks) await assert.doesNotReject(callback);
    assert.equal(f.state.credits.length, 1);
    assert.equal(f.state.voiceEvents.length, 1);
  }
});

test("disabled voice, an absent outbox event and historical imports never schedule voice work", async () => {
  for (const options of [{}, { voiceEnabled: true, enqueueResult: false }]) {
    const f = fixture(options);
    assert.equal((await call(f.route, [sample()], confirmation({ welcomeOnCreate: true }))).status, 200);
    assert.equal(f.state.afterCallbacks.length, 0);
  }
  const historical = fixture({ voiceEnabled: true });
  await call(historical.route, [sample(), sample(2)], confirmation());
  assert.equal(historical.state.afterCallbacks.length, 0);
});
