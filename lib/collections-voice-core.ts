import { createHmac, timingSafeEqual } from "node:crypto";

export const COLLECTIONS_VOICE_FROM = "+573124085562";
export const collectionsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CollectionsVoiceCampaign = {
  id: string; startDate: string; endDate: string; creditIds: number[]; maxAttempts: number;
  initialWindow?: { startsAt: string; endsAt: string };
};
export type CollectionsVoiceConfig = { campaign: CollectionsVoiceCampaign; webhookUrl: string; secret: string;
  flowSecret: string; agentId: string; fromNumber: typeof COLLECTIONS_VOICE_FROM };
const dateKey = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + "T12:00:00Z")) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;

export function getCollectionsVoiceConfig(env: Record<string, string | undefined> = process.env): CollectionsVoiceConfig | null {
  if (env.FINSERPAY_COLLECTIONS_VOICE_ENABLED !== "true") return null;
  // These workers do not share a transactional reservation with voice yet.
  // Never pretend that a read-before-send check eliminates that race.
  if (["DAPTA_DATOS_ENABLED", "DAPTA_RECORDATORIO_1_DIA_ENABLED", "DAPTA_HOYVENCE_ENABLED"]
    .some(key => env[key] === "true")) return null;
  try {
    const raw = env.FINSERPAY_COLLECTIONS_VOICE_CAMPAIGN_JSON || "";
    if (raw.length > 16384) return null;
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).some(key => !["id", "startDate", "endDate", "creditIds", "maxAttempts", "initialWindow"].includes(key))
      || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id)
      || !dateKey(value.startDate) || !dateKey(value.endDate) || value.endDate < value.startDate
      || !Array.isArray(value.creditIds) || !value.creditIds.length || value.creditIds.length > 500
      || value.creditIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > 2147483647)
      || new Set(value.creditIds).size !== value.creditIds.length
      || !Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 10000) return null;
    if (value.initialWindow !== undefined) {
      const w = value.initialWindow;
      if (!w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).some(key => !["startsAt", "endsAt"].includes(key))
        || typeof w.startsAt !== "string" || typeof w.endsAt !== "string"
        || !/Z$/.test(w.startsAt) || !/Z$/.test(w.endsAt)
        || !Number.isFinite(Date.parse(w.startsAt)) || !Number.isFinite(Date.parse(w.endsAt))
        || Date.parse(w.endsAt) <= Date.parse(w.startsAt) || Date.parse(w.endsAt) - Date.parse(w.startsAt) > 30 * 60000
        || collectionsColombiaClock(new Date(w.startsAt)).date !== value.startDate
        || collectionsColombiaClock(new Date(w.endsAt)).date !== value.startDate) return null;
    }
    const url = new URL(env.FINSERPAY_COLLECTIONS_VOICE_WEBHOOK_URL || "");
    const secret = env.FINSERPAY_COLLECTIONS_VOICE_TOKEN_SECRET || "";
    const flowSecret = env.FINSERPAY_COLLECTIONS_VOICE_FLOW_TOKEN || "";
    const agentId = env.FINSERPAY_COBRANZA_AGENT_ID || "";
    if (url.protocol !== "https:" || url.hostname !== "api.dapta.ai" || url.username || url.password
      || (url.port && url.port !== "443") || secret.length < 32 || !/^[A-Za-z0-9_-]{32,256}$/.test(flowSecret)
      || !collectionsUuid.test(agentId) || env.FINSERPAY_COLLECTIONS_VOICE_FROM_NUMBER !== COLLECTIONS_VOICE_FROM
      || env.FINSERPAY_COBRANZA_ACTOR_ID !== "51") return null;
    return { campaign: { ...value, creditIds: [...value.creditIds].sort((a: number, b: number) => a - b) },
      webhookUrl: url.href, secret, flowSecret, agentId, fromNumber: COLLECTIONS_VOICE_FROM };
  } catch { return null; }
}

export function collectionsColombiaClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** National holidays under Ley 51/1983, including the Monday transfers. */
export function colombianCollectionsHolidays(year: number): Set<string> {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return new Set();
  const day = (month: number, date: number) => new Date(Date.UTC(year, month - 1, date, 12));
  const key = (date: Date) => date.toISOString().slice(0, 10);
  const monday = (date: Date) => { date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7)); return key(date); };
  const result = new Set([[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]].map(([m, d]) => key(day(m, d))));
  for (const [m, d] of [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]]) result.add(monday(day(m, d)));
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = day(Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
  for (const offset of [-3, -2, 39, 60, 68]) {
    const date = new Date(easter); date.setUTCDate(date.getUTCDate() + offset);
    result.add(offset > 0 ? monday(date) : key(date));
  }
  return result;
}
export function isCollectionsVoiceLegalTime(now: Date): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  const p = collectionsColombiaClock(now), year = Number(p.date.slice(0, 4));
  if (year < 2000 || year > 2099 || colombianCollectionsHolidays(year).has(p.date)) return false;
  const weekday = new Date(p.date + "T12:00:00Z").getUTCDay();
  return weekday === 6 ? p.hour >= 8 && p.hour < 15 : weekday > 0 && p.hour >= 7 && p.hour < 19;
}
export function getCollectionsVoiceSlot(campaign: CollectionsVoiceCampaign, now: Date): string | null {
  if (!isCollectionsVoiceLegalTime(now)) return null;
  const p = collectionsColombiaClock(now);
  if (p.date < campaign.startDate || p.date > campaign.endDate) return null;
  const w = campaign.initialWindow;
  if (w && now.getTime() >= Date.parse(w.startsAt) && now.getTime() < Date.parse(w.endsAt)) return `${p.date}TINITIAL`;
  return [10, 14, 17].includes(p.hour) && p.minute < 30 ? `${p.date}T${p.hour}:00` : null;
}

export type CollectionsVoiceScope = { eventId: string; creditId: number };
export function createCollectionsVoiceToken(scope: CollectionsVoiceScope, secret: string, now = new Date()): string {
  if (!collectionsUuid.test(scope.eventId) || !Number.isSafeInteger(scope.creditId) || scope.creditId < 1 || secret.length < 32
    || !Number.isFinite(now.getTime())) throw new Error("INVALID_COLLECTIONS_TOKEN");
  const payload = Buffer.from(JSON.stringify({ purpose: "finserpay-collections-voice", eventId: scope.eventId, creditId: scope.creditId,
    issuedAt: Math.floor(now.getTime() / 1000), expiresAt: Math.floor(now.getTime() / 1000) + 86400 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyCollectionsVoiceToken(raw: unknown, secret: string, now = new Date()): CollectionsVoiceScope | null {
  if (typeof raw !== "string" || raw.length > 1024 || secret.length < 32 || !Number.isFinite(now.getTime())) return null;
  try {
    const parts = raw.split("."); if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
    const expected = createHmac("sha256", secret).update(parts[0]).digest(), supplied = Buffer.from(parts[1], "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")), time = Math.floor(now.getTime() / 1000);
    return p.purpose === "finserpay-collections-voice" && collectionsUuid.test(p.eventId)
      && Number.isSafeInteger(p.creditId) && p.creditId > 0 && Number.isSafeInteger(p.issuedAt)
      && Number.isSafeInteger(p.expiresAt) && p.issuedAt <= time + 30 && p.expiresAt > time
      && p.expiresAt - p.issuedAt === 86400 ? { eventId: p.eventId, creditId: p.creditId } : null;
  } catch { return null; }
}
export function collectionsFlowAuthorized(header: unknown, secret: string): boolean {
  if (typeof header !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) return false;
  const supplied = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header)?.[1];
  if (!supplied) return false;
  const a = Buffer.from(supplied), b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b);
}

export function collectionsVoiceResultDecision(outcome: string): "RETRY" | "CONTACTED" | "STOPPED" | "HELD" {
  return outcome === "NO_ANSWER" ? "RETRY" : outcome === "HUMAN_CONTACT" ? "CONTACTED" : outcome === "OPT_OUT" ? "STOPPED" : "HELD";
}
