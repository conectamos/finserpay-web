import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWelcomeAlertSummary, parseWelcomeAlertReceipt, shouldNotifyWelcome,
  WELCOME_ALERT_SOUND_COOLDOWN_MS, WELCOME_ALERT_REMINDER_MS,
} from '../lib/approval-welcome-alerts.ts';
const a = 'a'.repeat(32), b = 'b'.repeat(32);
const now = Date.parse('2026-10-08T15:00:00Z');
const summary = (attentionCount = 2, fingerprint = a) => ({
  ok: true, pendingCount: 8, attentionCount, fingerprint,
  href: '/dashboard/aprobaciones', checkedAt: '2026-10-08T15:00:00Z',
});

test('an actionable pending inbox alerts on arrival, including first sign-in', () => {
  assert.equal(shouldNotifyWelcome(summary(), null, now), true);
  assert.equal(shouldNotifyWelcome(summary(0), null, now), false);
});
test('same-count replacement is detected without continuous sound while work remains unchanged', () => {
  const receipt = { fingerprint: a, notifiedAt: now };
  assert.equal(shouldNotifyWelcome(summary(2, b), receipt, now + WELCOME_ALERT_SOUND_COOLDOWN_MS - 1), false);
  assert.equal(shouldNotifyWelcome(summary(2, b), receipt, now + WELCOME_ALERT_SOUND_COOLDOWN_MS), true);
  assert.equal(shouldNotifyWelcome(summary(), receipt, now + WELCOME_ALERT_REMINDER_MS - 1), false);
  assert.equal(shouldNotifyWelcome(summary(), receipt, now + WELCOME_ALERT_REMINDER_MS), true);
});
test('resolved or waiting-on-ally work never produces a reminder', () => {
  assert.equal(shouldNotifyWelcome(summary(0, b), { fingerprint: a, notifiedAt: 0 }, now), false);
});
test('another tab receipt suppresses duplicate notices; an invalid or far-future receipt recovers', () => {
  const receipt = parseWelcomeAlertReceipt({ fingerprint: a, notifiedAt: now });
  assert.equal(shouldNotifyWelcome(summary(), receipt, now + 30_000), false);
  assert.equal(shouldNotifyWelcome(summary(), receipt, now - 5000), false);
  assert.equal(shouldNotifyWelcome(summary(), { fingerprint: a, notifiedAt: now + 3600_000 }, now), true);
  for (const input of [null, [], { fingerprint: 'x', notifiedAt: now }, { fingerprint: a, notifiedAt: -1 }, { fingerprint: a, notifiedAt: '0' }]) {
    assert.equal(parseWelcomeAlertReceipt(input), null);
  }
});
test('only valid authenticated summaries can enter the alert state', () => {
  assert.deepEqual(parseWelcomeAlertSummary(summary()), { pendingCount: 8, attentionCount: 2, fingerprint: a, href: '/dashboard/aprobaciones', checkedAt: '2026-10-08T15:00:00Z' });
  for (const extra of [
    { ok: false }, { pendingCount: -1 }, { attentionCount: 9 }, { attentionCount: 1.5 },
    { fingerprint: 'untrusted' }, { href: 'https://outside.example' }, { checkedAt: 'bad' },
  ]) assert.equal(parseWelcomeAlertSummary({ ...summary(), ...extra }), null);
});
