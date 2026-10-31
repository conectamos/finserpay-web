export type AttentionPhoneTextPart = { text: string; phone?: string };

const MAX_MESSAGE_LENGTH = 20_000;
const MAX_PHONE_LENGTH = 64;
const horizontalSpace = /[\t\p{Zs}]/u;
const labels = "(?:c[ée]dulas?|c\\.?[ \\t]*c\\.?|documentos?|docs?|nit|imei|cr[ée]ditos?|solicitud(?:es)?|referencias?|recibos?|folio|id|fc|cop)";
const beforeLabel = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${labels}(?:[ \\t]+(?:del?|la|el|cliente|familiar|n[úu]mero|nro\\.?|no\\.?|es|para)){0,4}[ \\t\\r\\n:#=().-]*$`, "iu");
const afterLabel = new RegExp(`^[ \\t:;,(.-]*${labels}(?:$|[^\\p{L}\\p{N}_])`, "iu");

function blockedContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 100), start), after = text.slice(end, end + 40);
  if (/[#$][ \t\r\n:=.-]*$/.test(before) || /^[ \t]*[$#](?:[ \t]|$)/.test(after) || /^,\d{1,2}(?:\D|$)/.test(after) || beforeLabel.test(before) || afterLabel.test(after)) return true;
  // Never extract the numeric suffix/prefix of an identifier, path or underscored token.
  const previous = text.slice(Math.max(0, start - 2), start), following = text.slice(end, end + 2);
  if (/[\p{L}\p{N}_/+\\]$/u.test(previous) || /^[\p{L}\p{N}_/+\\]/u.test(following)) return true;
  if (/[\p{L}\p{N}_][.-]$/u.test(previous) || /^[.-][\p{L}\p{N}_]/u.test(following)) return true;
  return false;
}

function phoneValue(raw: string): string | undefined {
  let balance = 0;
  for (const char of raw) {
    if (char === "(" && ++balance > 2) return;
    if (char === ")" && --balance < 0) return;
  }
  if (balance) return;
  const compact = raw.replace(/[\t\p{Zs}().-]/gu, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  if (/^3\d{9}$/.test(compact)) {
    // Thousands-separated money is distinct from the usual 3-3-4 phone grouping.
    if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(raw)) return;
    return `+57${compact}`;
  }
  if (/^573\d{9}$/.test(compact)) return `+${compact}`;
  if (/^00573\d{9}$/.test(compact)) return `+${compact.slice(2)}`;
}

/** A display-only recognizer. It neither verifies ownership nor opens, creates or sends a chat. */
export function attentionPhoneTextParts(text: string): AttentionPhoneTextPart[] {
  if (!text || text.length > MAX_MESSAGE_LENGTH) return [{ text }];
  const urls: { start: number; end: number }[] = [];
  for (const token of text.matchAll(/\S+/gu)) {
    const value = token[0].replace(/^[([<{"'“‘]+/u, "");
    if (value.includes("://") || /^(?:[a-z][a-z0-9+.-]{0,30}:|www\.|wa\.me\/)/i.test(value)
      || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+[/?#:]/i.test(value)) {
      urls.push({ start: token.index, end: token.index + token[0].length });
    }
  }
  const parts: AttentionPhoneTextPart[] = [];
  let copied = 0, urlIndex = 0;
  for (let start = 0; start < text.length;) {
    while (urlIndex < urls.length && urls[urlIndex].end <= start) urlIndex++;
    if (urls[urlIndex] && start >= urls[urlIndex].start) { start = urls[urlIndex].end; continue; }
    if (!/[035+(]/.test(text[start]) || /[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, start - 2), start))) { start++; continue; }
    let end = start;
    // Scan a complete numeric run. Its bounded validation cannot link a short suffix of a long run.
    while (end < text.length && (/[0-9().-]/.test(text[end]) || horizontalSpace.test(text[end]) || (text[end] === "+" && (end === start || (end === start + 1 && text[start] === "("))))) end++;
    const runEnd = end;
    while (end > start && (horizontalSpace.test(text[end - 1]) || /[.(\-]/.test(text[end - 1]))) end--;
    const raw = text.slice(start, end), phone = raw.length <= MAX_PHONE_LENGTH ? phoneValue(raw) : undefined;
    if (phone && !blockedContext(text, start, end)) {
      if (start > copied) parts.push({ text: text.slice(copied, start) });
      parts.push({ text: raw, phone }); copied = end;
    }
    start = Math.max(start + 1, runEnd);
  }
  if (copied < text.length || !parts.length) parts.push({ text: text.slice(copied) });
  return parts;
}
