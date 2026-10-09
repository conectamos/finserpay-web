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
