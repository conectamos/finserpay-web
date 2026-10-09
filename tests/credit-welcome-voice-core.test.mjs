import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import("../lib/credit-welcome-voice-core.ts");
const secret = "synthetic-welcome-voice-secret-32-bytes-or-more";
const now = new Date("2026-10-08T15:00:00.000Z");
const identity = { eventId: "25ea074e-a7e5-4f2c-8c8e-e64258fe345d", creditId: 72 };

test("identity-flow credential only authenticates the dedicated private bearer", () => {
  const flowSecret = "synthetic-dedicated-identity-flow-key-32-or-more";
  assert.equal(core.verifyWelcomeVoiceIdentityFlowAuthorization(`Bearer ${flowSecret}`, { secret: flowSecret }), true);
  for (const value of [null, undefined, 123, flowSecret, `Bearer ${flowSecret}-other`, `Bearer ${secret}`, `Bearer ${flowSecret}\n`]) {
    assert.equal(core.verifyWelcomeVoiceIdentityFlowAuthorization(value, { secret: flowSecret }), false);
  }
  assert.equal(core.verifyWelcomeVoiceIdentityFlowAuthorization("Bearer short", { secret: "short" }), false);
});

test("signed token is restricted to one event and credit and expires", () => {
  const token = core.createWelcomeVoiceToken(identity, { secret, now, ttlSeconds: 60 });
  assert.deepEqual(core.verifyWelcomeVoiceToken(token, { secret, now }), {
    ...identity, issuedAt: Math.floor(now.getTime() / 1000), expiresAt: Math.floor(now.getTime() / 1000) + 60,
  });
  assert.equal(core.verifyWelcomeVoiceToken(token, { secret, now: new Date(now.getTime() + 60000) }), null);
  assert.equal(core.verifyWelcomeVoiceToken(token, { secret: `${secret}-other`, now }), null);
  const [encoded, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, creditId: 73 })).toString("base64url");
  assert.equal(core.verifyWelcomeVoiceToken(`${forged}.${signature}`, { secret, now }), null);
  assert.equal(core.verifyWelcomeVoiceToken(`${token}.extra`, { secret, now }), null);
  assert.equal(core.verifyWelcomeVoiceToken(token, { secret: "short", now }), null);
});

test("tokens reject invalid configuration and future issue times", () => {
  assert.throws(() => core.createWelcomeVoiceToken(identity, { secret: "short", now }));
  assert.throws(() => core.createWelcomeVoiceToken({ ...identity, creditId: -1 }, { secret, now }));
  assert.throws(() => core.createWelcomeVoiceToken(identity, { secret, now, ttlSeconds: 86401 }));
  const future = core.createWelcomeVoiceToken(identity, { secret, now: new Date(now.getTime() + 60000) });
  assert.equal(core.verifyWelcomeVoiceToken(future, { secret, now }), null);
});

test("identity requires every registered name component and exact document, preserving leading zeroes", () => {
  const expected = { name: "Ana María Pérez", document: "0012345678" };
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: " ANA MARIA  PEREZ ", document: "00.123.456-78" }), true);
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: "Ana Pérez", document: "0012345678" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: "Ana María Pérez", document: "12345678" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: "Ana María Pérez", document: "0012?45678" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: "Otra Persona", document: "0012345678" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity({ name: "LUZ HERNANDEZ", document: "38144092" },
    { name: "Luz Estela Hernández Gili", document: "38144092" }), true);
  assert.equal(core.matchWelcomeVoiceIdentity({ name: "LUZ HERNANDEZ", document: "38144092" },
    { name: "Luz Estela Hernández Gili", document: "38144093" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity({ name: "LUZ HERNANDEZ", document: "38144092" },
    { name: "Luz, que esté a la Hernández.", document: "38144092" }), true);
  assert.equal(core.matchWelcomeVoiceIdentity({ name: "LUZ HERNANDEZ", document: "38144092" },
    { name: "Luz, que esté a la Hernández.", document: "38144093" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity({ name: "LUZ HERNANDEZ", document: "38144092" },
    { name: "Luz, que esté a la García.", document: "38144092" }), false);
  assert.equal(core.normalizeWelcomeVoiceDocument(12345678), null);
});

test("only private Dapta application links are exposed to the operator", () => {
  assert.equal(core.safeDaptaWelcomeVoiceUrl("https://app.dapta.ai/call/example"), "https://app.dapta.ai/call/example");
  for (const url of ["javascript:alert(1)", "https://app.dapta.ai.evil.test/call", "https://files.dapta.ai/audio/example", "http://app.dapta.ai/call", "https://user:password@app.dapta.ai/call", "https://app.dapta.ai:8443/call", "audio/call.ogg"]) {
    assert.equal(core.safeDaptaWelcomeVoiceUrl(url), null);
  }
});
test("welcome application accepts one whole registered name or surname only with the exact full document", () => {
  const expected = { name: "LUZ HERNANDEZ", document: "38144092" };
  for (const name of ["Luz Fernández Gil.", "Luz", "Hernández", "Estela Hernández Gil"]) {
    assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document: "38.144.092" }), true, name);
    assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document: "38144093" }), false, name);
  }
  for (const name of ["Fernández Gil", "Luzmila", "Hernande", "Otro Nombre", "de la y"]) {
    assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document: "38144092" }), false, name);
  }
  assert.equal(core.matchWelcomeVoiceApplicationIdentity({ name: "Ana de la Cruz", document: "00123456" }, { name: "de la", document: "00123456" }), false);
  assert.equal(core.matchWelcomeVoiceApplicationIdentity({ name: "Ana de la Cruz", document: "00123456" }, { name: "Cruz", document: "00123456" }), true);
  assert.equal(core.matchWelcomeVoiceApplicationIdentity({ name: "Ana", document: "00123456" }, { name: "Ana", document: "123456" }), false);
  assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name: "Luz " + "otra ".repeat(20), document: "38144092" }), false);
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: "Luz Fernández Gil.", document: "38144092" }), false, "collections/default policy is unchanged");
});

test("private welcome recognizes the observed Cindy/Sindy pronunciation with an exact complete document", () => {
  // The utterance is the observed ASR shape; the document is a synthetic fixture.
  const expected = { name: "SINDY MALLERLY GUTIERREZ LOZANO", document: "0012345678" };
  const name = "Cindy, ayer liquidé relocanos.";
  assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document: "00.123.456-78" }), true);
  for (const document of ["0012345679", "12345678", "001234567", "001234?678", 12345678, null]) {
    assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document }), false);
  }
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name, document: expected.document }), false);
});

test("private welcome pronunciation is limited to soft C and S/Z in entire meaningful tokens", () => {
  for (const [registered, spoken] of [
    ["Sindy", "Cindy"], ["Cindy", "Sindy"], ["Sindy", "Zindy"],
    ["Cecilia", "Sesilia"], ["César", "Sésar"], ["Luz", "Lus"],
    ["Ana de la Cruz", "Crus"], ["SÍNDY", "CÍNDY"],
  ]) assert.equal(core.matchesWelcomeVoiceApplicationName(registered, spoken), true, `${registered}/${spoken}`);
  for (const [registered, spoken] of [
    ["Sindy", "Cindyrella"], ["Sindy", "Cin"], ["Sindy", "Cinthia"],
    ["Carlos", "Sarlos"], ["Cata", "Sata"], ["Cora", "Sora"],
    ["Cuca", "Suca"], ["Chaves", "Shaves"], ["Cristina", "Sristina"],
    ["Carla", "Karla"], ["Luz", "César"], ["Ana de la Cruz", "de la"],
    ["de del la las los y el", "de la y"], ["Sindy", "Cindy?"],
  ]) assert.equal(core.matchesWelcomeVoiceApplicationName(registered, spoken), false, `${registered}/${spoken}`);
  assert.equal(core.matchesWelcomeVoiceApplicationName("Sindy", "Cindy " + "otra ".repeat(20)), false);
  for (const [registered, spoken] of [["Sindy", "Cindy"], ["César", "Sésar"], ["Luz", "Lus"]]) {
    assert.equal(core.matchWelcomeVoiceIdentity({ name: registered, document: "0012345678" },
      { name: spoken, document: "0012345678" }), false, "generic matcher stays literal");
  }
});

test("private welcome accepts the bounded double-T spelling of a whole surname with an exact document", () => {
  const expected = { name: "ANA ARRIETA LOPEZ", document: "0012345678" };
  for (const name of ["Otro Arrietta Otro.", "Arrietta", "Ana García"]) {
    assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document: expected.document }), true, name);
    for (const document of ["0012345679", "12345678", "001234567", null]) {
      assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document }), false, `${name}/${document}`);
    }
  }
  for (const name of ["Arriett", "Arriettana", "Arriettta", "Otro Nombre", "de la"]) {
    assert.equal(core.matchWelcomeVoiceApplicationIdentity(expected, { name, document: expected.document }), false, name);
  }
  for (const [registered, spoken] of [["Carrillo", "Carillo"], ["Carrillo", "Carrilo"],
    ["Accardi", "Acardi"], ["Charri", "Charris"], ["Deiby", "David"], ["Deiby", "Davis"], ["Matt", "Mat"]]) {
    assert.equal(core.matchesWelcomeVoiceApplicationName(registered, spoken), false, `${registered}/${spoken}`);
  }
  assert.equal(core.matchesWelcomeVoiceApplicationName("Arrietta", "Arrieta"), true);
  assert.equal(core.matchWelcomeVoiceIdentity(expected, { name: "Ana Arrietta Lopez", document: expected.document }), false);
});
