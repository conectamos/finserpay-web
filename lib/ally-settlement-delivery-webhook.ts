import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySettlementWebhook(raw: string, signature: string | null, secret: string | undefined) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function settlementWebhookEvents(payload: unknown, phoneNumberId: string) {
  const events: Array<{ attemptId: string; providerId: string; recipient: string; status: string; timestamp: Date }> = [];
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const object = record(payload);
  if (object.object !== "whatsapp_business_account" || !/^\d{5,30}$/.test(phoneNumberId)) return events;
  for (const entry of array(object.entry)) for (const item of array(record(entry).changes)) {
    const change = record(item);
    const value = record(change.value);
    // Metadata is mandatory: a valid signature from another account/line must
    // not reconcile this sender's settlement attempts.
    if (change.field !== "messages" || record(value.metadata).phone_number_id !== phoneNumberId) continue;
    for (const item of array(value.statuses)) {
      const status = record(item);
      const attemptId = status.biz_opaque_callback_data;
      const providerId = status.id;
      const recipient = status.recipient_id;
      if (typeof attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId) ||
          typeof providerId !== "string" || !/^wamid\.[A-Za-z0-9_+=/-]{1,490}$/.test(providerId) ||
          typeof recipient !== "string" || !/^[1-9]\d{7,14}$/.test(recipient) ||
          typeof status.status !== "string" || !["sent", "delivered", "read", "failed"].includes(status.status) ||
          typeof status.timestamp !== "string" || !/^[1-9]\d{0,12}$/.test(status.timestamp)) continue;
      const timestamp = new Date(Number(status.timestamp) * 1000);
      if (!Number.isFinite(timestamp.getTime())) continue;
      events.push({ attemptId, providerId, recipient, status: status.status, timestamp });
    }
  }
  return events;
}
