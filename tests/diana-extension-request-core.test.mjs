import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { validateDianaRequestProof, dianaRequestChoice, dianaRequestHash, dianaRequestFollowUp } = await jiti.import("../lib/diana-extension-request-core.ts");
const scope = { workspaceId: randomUUID(), agentId: randomUUID(), agentChannelId: randomUUID(), phoneNumberId: "1162059967000416", wabaId: "2148284059050848" };
const now = new Date("2026-11-02T17:00:00Z"), floor = "2026-11-02T16:00:00Z";
const proof = () => ({ scope, conversationId: randomUUID(), externalConversationId: randomUUID(), contactId: "573001234567", phone: "+573001234567",
  messageId: randomUUID(), messageAt: "2026-11-02T16:59:59Z", observedAt: now.toISOString(), deliveryId: randomUUID(), textDigest: "a".repeat(64), latest: true, intent: { kind: "days", days: 1 } });

test("direct requests require a fresh native witness, exact authorized scope and a post-activation customer message", () => {
  const value = proof();
  assert.doesNotThrow(() => validateDianaRequestProof(value, scope, floor, now));
  for (const patch of [{ latest: false }, { phone: "+573001234568" }, { textDigest: "" }, { messageId: "model-message" },
    { contactId: "@username" }, { scope: { ...scope, wabaId: "999" } }])
    assert.throws(() => validateDianaRequestProof({ ...value, ...patch }, scope, floor, now), { status: 403 });
  for (const patch of [{ messageAt: "2026-11-02T15:59:59Z" }, { messageAt: "2026-11-02T16:45:00Z" },
    { messageAt: "2026-11-02T17:00:01Z" }, { observedAt: "2026-11-02T16:59:28Z" }, { observedAt: "2026-11-02T17:00:06Z" }])
    assert.throws(() => validateDianaRequestProof({ ...value, ...patch }, scope, floor, now), { status: 409 });
  assert.throws(() => validateDianaRequestProof(value, scope, "", now), { status: 503 });
  assert.throws(() => validateDianaRequestProof({ ...value, intent: { kind: "days", days: 5 } }, scope, floor, now), { status: 409 });
  assert.throws(() => validateDianaRequestProof({ ...value, intent: { kind: "date", date: "2026-02-30" } }, scope, floor, now));
});

test("days and explicit calendar date must select exactly the same current CRM option", () => {
  const choices = [1, 2, 3, 4].map(days => ({ days, expiresOn: `2026-11-0${2 + days}` }));
  assert.deepEqual(dianaRequestChoice({ kind: "days", days: 1, date: "2026-11-03" }, choices), choices[0]);
  assert.deepEqual(dianaRequestChoice({ kind: "date", date: "2026-11-06" }, choices), choices[3]);
  assert.equal(dianaRequestChoice({ kind: "days", days: 4, date: "2026-11-03" }, choices), null);
  assert.equal(dianaRequestChoice({ kind: "date", date: "2026-11-07" }, choices), null);
  assert.equal(dianaRequestChoice({ kind: "days", days: 1 }, choices.slice(1)), null);
});

test("provider retry/read timestamps cannot change request identity; actual message or terms do", () => {
  const value = proof(), digest = dianaRequestHash(value);
  assert.equal(dianaRequestHash({ ...value, observedAt: "2026-11-02T17:00:01Z", deliveryId: randomUUID() }), digest);
  for (const patch of [{ intent: { kind: "days", days: 2 } }, { messageId: randomUUID() }, { textDigest: "b".repeat(64) }, { phone: "+573001234568" }])
    assert.notEqual(dianaRequestHash({ ...value, ...patch }), digest);
  assert.equal(dianaRequestFollowUp("2026-12-31").toISOString(), "2027-01-01T13:00:00.000Z");
});
