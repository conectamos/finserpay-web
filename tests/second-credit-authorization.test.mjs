import assert from "node:assert/strict";
import test from "node:test";
import { core, store, creditFactory, actor, document, credit, permission, mutation, database } from "./second-credit-authorization-fixture.mjs";

const uuid2 = "d1d2eaf0-2894-47fb-97c8-adfbc0d4a753";

test("normalización coincide con blacklist y conserva la cédula exacta sin notación científica", () => {
  for (const input of [document, `00${document}`, "1.062.402.825", "1 062 402 825"]) assert.equal(core.normalizeSecondCreditDocument(input), document);
  for (const input of [null, 1062402825, "1E+15", "CC1062402825", "12", "0", "12345678901234"]) assert.throws(() => core.normalizeSecondCreditDocument(input), { code: "INVALID_DOCUMENT" });
});

test("alta y revocación requieren motivo, versión y UUID con actor fuera del cuerpo", () => {
  assert.equal(mutation().expectedVersion, 0);
  assert.equal(mutation({ action: "REVOKE", expectedVersion: 1 }).action, "REVOKE");
  for (const invalid of [{ reason: "" }, { reason: " ".repeat(6) }, { reason: "x".repeat(501) }, { expectedVersion: -1 }, { expectedVersion: "1" }, { mutationId: "unidentified" }, { action: "UNLIMITED" }]) {
    assert.throws(() => mutation(invalid), core.SecondCreditAuthorizationError);
  }
});

test("saldo usa la regla vigente: no resta cuota inicial; un abono anulado no cuenta", async () => {
  const { db, calls } = database({ credits: [credit(1, { montoCredito: 1000, cuotaInicial: 1000, totalAbonado: 999, abonosCount: 1 })] });
  const result = (await store.getSecondCreditEligibility(db, [document])).get(document);
  assert.equal(result.activeCredits, 1);
  assert.equal(result.canCreate, false);
  const query = calls.queries.find(({ sql }) => sql.includes('FROM public."Credito"')).sql;
  assert.match(query, /a\."estado" <> 'ANULADO'/);
  assert.match(query, /c\."estado" <> 'ANULADO'/);
  assert.match(query, /'\[\^0-9\]'/);
  assert.equal(creditFactory.resolveCreditPaymentSummary({ montoCredito: 1000, cuotaInicial: 1000, totalAbonado: 999, abonosCount: 1 }).saldoPendiente, 1);
});

test("sin excepción nueva, un crédito vigente bloquea aunque una excepción histórica permitiera varios", async () => {
  const { db, calls } = database({ credits: [credit()] });
  await assert.rejects(store.assertSecondCreditEligibility(db, document), { code: "ACTIVE_CREDIT_EXISTS", status: 409 });
  assert.equal(calls.queries.some(({ sql }) => /Excepcion|permiteMultiples/i.test(sql)), false);
});

test("cerrado al 100% permite crear sin excepción y no registra autorización inexistente", async () => {
  const { db } = database({ credits: [credit(1, { totalAbonado: 1000, abonosCount: 2 })] });
  assert.equal(await store.assertSecondCreditEligibility(db, document), null);
  const row = (await store.getSecondCreditEligibility(db, [document])).get(document);
  assert.equal(row.activeCredits, 0);
  assert.equal(row.canCreate, true);
});

test("una autorización activa permite segundo y devuelve la revisión exacta para el snapshot", async () => {
  const { db } = database({ credits: [credit()], authorizations: [permission()] });
  const audit = await store.assertSecondCreditEligibility(db, `00${document}`, { lock: true });
  assert.equal(audit.id, permission().id);
  assert.equal(audit.version, 1);
  assert.equal(audit.documento, document);
  assert.equal(audit.authorizedByName, actor.nombre);
  assert.equal(audit.authorizedAt, permission().updatedAt);
  assert.deepEqual(Array.from(audit.activeCreditIds), [1]);
});

test("la autorización nunca permite un tercer crédito ni saldos parcialmente pagados", async () => {
  for (const authorizations of [[], [permission()], [permission({ active: false })]]) {
    const { db } = database({ credits: [credit(1), credit(2, { totalAbonado: 999 })], authorizations });
    const row = (await store.getSecondCreditEligibility(db, [document])).get(document);
    assert.equal(row.activeCredits, 2);
    assert.equal(row.canCreate, false);
    await assert.rejects(store.assertSecondCreditEligibility(db, document), { code: "SECOND_CREDIT_LIMIT_REACHED", status: 409 });
  }
});

test("permiso revocado vuelve a bloquear el segundo sin modificar créditos existentes", async () => {
  const { db, state } = database({ credits: [credit()], authorizations: [permission({ active: false, version: 2 })] });
  const prior = structuredClone(state.credits);
  await assert.rejects(store.assertSecondCreditEligibility(db, document), { code: "ACTIVE_CREDIT_EXISTS" });
  assert.deepEqual(state.credits, prior);
});

test("errores de esquema, conexión o números no finitos fallan cerrados con mensaje sin PII", async () => {
  for (const options of [{ queryError: new Error(`secret-${document}`) }, ...[NaN, Infinity, undefined, null].map((value) => ({ credits: [credit(1, { montoCredito: value })] }))]) {
    const { db } = database(options);
    await assert.rejects(store.assertSecondCreditEligibility(db, document), (error) => {
      assert.equal(error.code, "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE");
      assert.equal(error.status, 503);
      assert.equal(error.message.includes(document), false);
      return true;
    });
  }
});

test("creación, revocación y reinstalación dejan eventos inmutables con actor y versiones", async () => {
  const { db, state, calls } = database({ credits: [credit()] });
  const grant = await db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation(), actor));
  assert.equal(grant.authorization.active, true);
  assert.equal(grant.authorization.version, 1);
  const replay = await db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation(), actor));
  assert.equal(replay.idempotent, true);
  assert.equal(state.events.length, 1);
  const revoke = mutation({ action: "REVOKE", expectedVersion: 1, mutationId: uuid2, reason: "Permiso revocado por administrador central" });
  const revoked = await db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, revoke, actor));
  assert.equal(revoked.authorization.active, false);
  assert.equal(revoked.authorization.version, 2);
  assert.equal(revoked.canCreate, false);
  const lateReplay = await db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation(), actor));
  assert.equal(lateReplay.authorization.active, false, "reintentar una vieja alta nunca debe reinstalar el permiso revocado");
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].before, null);
  assert.equal(JSON.parse(state.events[1].before).version, 1);
  assert.equal(JSON.parse(state.events[1].after).version, 2);
  assert.equal(state.events[1].actorUserId, actor.id);
  assert.equal(state.events[1].actorName, actor.nombre);
  assert.ok(calls.executions.some(({ params }) => params[0] === `DOCUMENT_BLACKLIST:${document}`));
  assert.equal(calls.executions.some(({ sql }) => /UPDATE|DELETE/.test(sql)), false);
});

test("doble alta, versión vieja y UUID reutilizado no habilitan nuevos permisos", async () => {
  const { db } = database({ credits: [credit()] });
  await db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation(), actor));
  await assert.rejects(db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation({ mutationId: uuid2 }), actor)), { code: "VERSION_CONFLICT" });
  await assert.rejects(db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation({ mutationId: uuid2, expectedVersion: 1 }), actor)), { code: "STATE_CONFLICT" });
  await assert.rejects(db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation({ reason: "Otra razón para la misma operación" }), actor)), { code: "MUTATION_CONFLICT" });
});

test("dos vigentes impiden nueva autorización pero permiten revocarla sin cancelar créditos", async () => {
  const { db, state } = database({ credits: [credit(1), credit(2)], authorizations: [permission({ active: false })] });
  const prior = structuredClone(state.credits);
  await assert.rejects(db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation({ expectedVersion: 1 }), actor)), { code: "SECOND_CREDIT_LIMIT_REACHED" });
  state.authorizations = [permission()];
  const result = await db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation({ action: "REVOKE", expectedVersion: 1 }), actor));
  assert.equal(result.authorization.active, false);
  assert.equal(result.activeCredits, 2);
  assert.equal(result.canCreate, false);
  assert.deepEqual(state.credits, prior);
});

test("falla de auditoría o inserción cero revierte el permiso entero en la transacción", async () => {
  for (const options of [{ auditError: new Error("failed audit") }, { auditCount: 0 }]) {
    const { db, state } = database(options);
    await assert.rejects(db.$transaction((tx) => store.mutateSecondCreditAuthorization(tx, mutation(), actor)));
    assert.equal(state.authorizations.length, 0);
    assert.equal(state.events.length, 0);
  }
});
test("auditoría del snapshot convierte TIMESTAMPTZ Date a ISO y falla cerrada si la fecha es inválida", async () => {
  const { db } = database({ credits: [credit()], authorizations: [permission({ updatedAt: new Date("2026-09-27T16:45:00.000Z") })] });
  const audit = await store.assertSecondCreditEligibility(db, document);
  assert.equal(typeof audit.authorizedAt, "string");
  assert.equal(audit.authorizedAt, "2026-09-27T16:45:00.000Z");
  const invalid = database({ credits: [credit()], authorizations: [permission({ updatedAt: "invalid date" })] });
  await assert.rejects(store.assertSecondCreditEligibility(invalid.db, document), { code: "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE" });
});