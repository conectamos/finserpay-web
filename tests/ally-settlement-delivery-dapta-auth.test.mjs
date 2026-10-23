import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const contacts = loadReissueModule("lib/ally-contact.ts");
const { createSettlementDaptaToken, verifySettlementDaptaToken } = loadReissueModule("lib/ally-settlement-delivery-dapta-auth.ts", { "./ally-contact": contacts });
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recipient = "573001234567";
const env = { ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "synthetic-dapta-hmac-secret-32-bytes-minimum" };
const now = Date.parse("2026-10-23T18:00:00.000Z");

test("token efímero vincula intento y destinatario, sin revelar la llave compartida", () => {
  const token = createSettlementDaptaToken(id, recipient, env, now);
  assert.match(token, /^v1\.\d+\.[a-f0-9]{64}$/);
  assert.ok(!token.includes(env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET));
  assert.equal(verifySettlementDaptaToken(token, id, recipient, env, now), true);
  assert.equal(verifySettlementDaptaToken(token, other, recipient, env, now), false);
  assert.equal(verifySettlementDaptaToken(token, id, "573009876543", env, now), false);
  assert.equal(verifySettlementDaptaToken(token, id, recipient, { ...env, ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "different-secret-that-is-also-at-least-32-bytes" }, now), false);
  assert.equal(verifySettlementDaptaToken(env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET, id, recipient, env, now), false);
});

test("normalización canónica acepta el mismo teléfono y UUID sin permitir otro destinatario", () => {
  const token = createSettlementDaptaToken(id.toUpperCase(), "+57 300 123 4567", env, now);
  assert.equal(token, createSettlementDaptaToken(id, "3001234567", env, now));
  assert.equal(verifySettlementDaptaToken(token, id.toUpperCase(), "+57 300 123 4567", env, now), true);
  assert.equal(verifySettlementDaptaToken(token, id, "invalid-phone", env, now), false);
});

test("caduca a los treinta minutos exactos y rechaza vencimientos demasiado lejanos", () => {
  const token = createSettlementDaptaToken(id, recipient, env, now);
  assert.equal(verifySettlementDaptaToken(token, id, recipient, env, now + 1800_000 - 1), true);
  assert.equal(verifySettlementDaptaToken(token, id, recipient, env, now + 1800_000), false);
  assert.equal(verifySettlementDaptaToken(token, id, recipient, env, now + 1800_001), false);
  assert.equal(verifySettlementDaptaToken(token, id, recipient, env, now - 1000), false);
  const future = createSettlementDaptaToken(id, recipient, env, now + 3600_000);
  assert.equal(verifySettlementDaptaToken(future, id, recipient, env, now), false);
});

test("mutaciones de versión, firma, vencimiento y espacios fallan cerradas", () => {
  const token = createSettlementDaptaToken(id, recipient, env, now);
  const [version, expiry, signature] = token.split(".");
  for (const value of [
    "", null, undefined, `v2.${expiry}.${signature}`, `v1.0.${signature}`, `v1.${Number(expiry) + 1}.${signature}`,
    `${version}.${expiry}.${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`,
    `${version}.${expiry}.${signature.toUpperCase()}`, `${token} `, ` ${token}`, `${token}\n`, `${token}.extra`,
  ]) assert.equal(verifySettlementDaptaToken(value, id, recipient, env, now), false, String(value));
});

test("dominio HMAC aislado impide reutilizar firmas de documentos u otros callbacks", () => {
  const token = createSettlementDaptaToken(id, recipient, env, now);
  const [, expiry] = token.split(".");
  const wrongScope = createHmac("sha256", env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET)
    .update(`FINSER_PAY_SETTLEMENT_MEDIA\nv1\n${id}\n${recipient}\n${expiry}`).digest("hex");
  assert.equal(verifySettlementDaptaToken(`v1.${expiry}.${wrongScope}`, id, recipient, env, now), false);
});

test("secretos ausentes, débiles o con controles y parámetros inválidos no generan tokens", () => {
  for (const key of [undefined, "short", "x".repeat(31), ` ${"x".repeat(32)}`, `${"x".repeat(32)}\n`, "x".repeat(4097)]) {
    const invalid = { ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: key };
    assert.throws(() => createSettlementDaptaToken(id, recipient, invalid, now));
    assert.equal(verifySettlementDaptaToken("invalid", id, recipient, invalid, now), false);
  }
  for (const values of [["bad", recipient, now], [id, "bad", now], [id, recipient, -1], [id, recipient, 0.5], [id, recipient, Infinity]]) {
    assert.throws(() => createSettlementDaptaToken(values[0], values[1], env, values[2]));
  }
  const unicodeSecret = { ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "á".repeat(16) };
  const token = createSettlementDaptaToken(id, recipient, unicodeSecret, now);
  assert.equal(verifySettlementDaptaToken(token, id, recipient, unicodeSecret, now), true, "Minimum is UTF-8 bytes, not codepoint count");
});
