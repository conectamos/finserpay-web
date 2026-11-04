import type { DianaExtensionRequestIntent } from "./diana-extension-request-types";

/** Private, bounded native conversation context; never stored or returned by the API. */
export type DianaRequestContextMessage = {
  id: string; text: string; sentAt: string; kind: "lead" | "agent";
  direction: "inbound" | "outbound";
};
export type DianaRequestResolution = {
  intent: DianaExtensionRequestIntent;
  /** IDs of the original request and any explicit clarification, in native order. */
  evidenceIds: string[];
};
const numberWord = "(?:[0-9]{1,2}|un|uno|una|dos|tres|cuatro)";
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const number = (value: string) => ({ un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4 }[value] ?? Number(value));
const quotedOrThirdParty = (text: string) => /[">“”«»]|(?:^|\n)\s*>/.test(text)
  || /\b(?:el cliente|la clienta|un cliente|una clienta|mi (?:mama|papa|herman[oa]|amig[oa]|espos[oa])|para otra persona|para un tercero)\b/.test(normalize(text));
const cancelled = (text: string) => {
  // The noun in a request for "días de espera" is not the imperative "espera".
  // Remove only that exact expression; a separate pause/cancellation still wins.
  const value = normalize(text).replace(/\bdias? de espera\b/g, "plazo");
  return /\b(?:no (?:(?:la|lo|las|los|me) )?(?:quiero|necesito|deseo|solicito|acepto)|no (?:(?:me|la|lo|las|los) ){1,2}(?:des|de|apliques|aplique|concedas|conceda)|ya no|cancel[ae](?:r)?|anul[ae](?:r)?|no apliques|no aplique|ya (?:pague|cancele|pago)|espera|espere|un momento|olvidalo|olvidela|suspende|suspenda)\b/.test(value)
    || /^(?:no(?: gracias)?|mejor no|dejalo|dejela)[.!? ]*$/.test(value);
};
const topic = (text: string) => /\b(?:prorroga|plazo|aplazamiento|aplazar|extender|extension|dias? de espera)\b/.test(normalize(text));
function requestFrame(text: string) {
  const value = normalize(text.replace(/^\s*sí[,\s]+/i, ""));
  if (!value || value.length > 2000 || quotedOrThirdParty(text) || cancelled(text)
    || /\b(?:quiero saber|quisiera saber|necesito saber|que es|que significa|que pasa|que sucede|que ocurre|que requisitos|cuales requisitos|que necesito|cuantas veces|como funciona|como (?:pedir|solicitar|pido|solicito)|cuanto cuesta|expli\w*|informacion|informarme|consultar|consulta|preguntar|por ejemplo|hipotetic\w*|tal vez|quizas|de pronto|si|en caso de|no estoy segur\w*|no tengo claro|me preguntaron|me dijeron|(?:asesor|analista|cliente) (?:dijo|dice|pregunto|solicita)|dice que|dijo que)\b/.test(value)) return false;
  // Only a personal main clause authorizes an action. Finding a request verb
  // inside reported speech or a hypothetical sentence is insufficient.
  let main = value.replace(/^[¿¡\s]+/, "");
  for (let count = 0; count < 4; count++) {
    const stripped = main.replace(/^(?:hola|buenos dias|buenas(?: tardes| noches)?|diana|por favor|disculpa|disculpe)[,.:!\s]+/, "");
    if (stripped === main) break;
    main = stripped;
  }
  main = main.replace(/^(?:es que )?(?:no tengo|no cuento con|estoy sin) (?:el )?(?:dinero|plata)(?: (?:en este momento|en el momento|ahora|hoy))?[,.;:]\s*/, "");
  const object = "(?:(?:una?|la|mi|el)\\s+)?(?:prorroga|plazo|aplazamiento|extension)\\b";
  const personal = "(?:necesito|solicito|quiero|quisiera|deseo|pido)(?:\\s+(?:pedir|solicitar))?|dame|deme|darme|concedeme|concedame|regalame|regaleme|me (?:puedes?|podrias?|podria|pueden) (?:dar|conceder|regalar|otorgar)|me (?:das|da|regalas?|regala|concedes?|concede)|(?:puedes?|podrias?) (?:darme|concederme|regalarme)|puedo tener";
  // A bounded personal request can introduce the term before Diana asks how
  // many days. Neither the agent's question nor the phrase alone supplies days.
  const waitingRequest = new RegExp("^(?:" + personal + "|para que me (?:den|de|concedan|conceda))\\s+(?:(?:los|unos|mis|un|el)\\s+)?dias? de espera(?:,?\\s+(?:por favor|muchas gracias|gracias))*[.!]*$").test(main);
  const duration = numberWord + "\\s+dias?";
  const deadline = "(?:manana|pasado manana|hoy|\\d{4}-\\d{2}-\\d{2}|\\d{2}/\\d{2}/\\d{4})";
  const origin = "(?:\\s+(?:desde (?:hoy|el vencimiento)|despues del vencimiento|a partir de hoy))?";
  const suffix = "(?:\\s+por favor)?[.!]*$";
  // A short nominal request is accepted only as a complete expression, never
  // as a prefix of a question about permission, requirements or policy.
  const nominal = new RegExp("^(?:solicitud de )?prorroga\\s+(?:(?:(?:de|por)\\s+)?" + duration + origin
    + "(?:\\s+hasta(?: el)?\\s+" + deadline + ")?|(?:hasta|para)(?: el)?\\s+" + deadline + ")" + suffix).test(main)
    || new RegExp("^" + duration + "\\s+(?:de\\s+)?prorroga" + suffix).test(main);
  return waitingRequest || topic(main) && (new RegExp("^(?:" + personal + ")\\s+" + object).test(main)
    || new RegExp("^me (?:ayudas?|ayuda|puedes? ayudar) con\\s+" + object).test(main)
    || new RegExp("^(?:necesito|solicito|quiero|quisiera|deseo|pido)\\s+" + duration + "\\s+de\\s+(?:prorroga|plazo)" + origin + suffix).test(main)
    || nominal);
}
function dateKey(at: string) {
  const parsed = new Date(at);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(parsed).map(part => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function calendar(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T12:00:00Z"))
    && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value ? value : null;
}
function plusDays(day: string, days: number) {
  const result = new Date(day + "T12:00:00Z");
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
function folio(text: string): string | null | undefined {
  const values = [...text.matchAll(/\b(?:cr[eé]dito|folio)(?:\s+(?:n[uú]mero|nro|no))?\s*[:#-]?\s*([a-z0-9][a-z0-9._-]{0,119})/gi)]
    .map(match => match[1].replace(/[.,;:!?]+$/, "")).filter(value => /\d/.test(value));
  const unique = [...new Set(values)];
  return unique.length > 1 ? null : unique[0];
}
function terms(text: string, at: string): DianaExtensionRequestIntent | null {
  const value = normalize(text), base = dateKey(at);
  if (!base || quotedOrThirdParty(text) || cancelled(text)
    || new RegExp("\\b" + numberWord + "\\s*(?:-|–|—|o|a|y)\\s*" + numberWord + "\\s*dias?\\b").test(value)
    || /\b(?:unos|aproximadamente|tal vez|quizas|de pronto)\b/.test(value)) return null;
  const matches = [...value.matchAll(new RegExp("\\b(" + numberWord + ")\\s*dias?\\b", "g"))];
  const days = [...new Set(matches.map(match => number(match[1])))];
  if (days.length > 1 || days.some(day => ![1, 2, 3, 4].includes(day))) return null;
  const dates: string[] = [];
  for (const match of value.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    const day = calendar(match[1]); if (!day) return null; dates.push(day);
  }
  for (const match of value.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)) {
    const day = calendar(match[3] + "-" + match[2] + "-" + match[1]); if (!day) return null; dates.push(day);
  }
  let relative = value;
  if (/\bpasado manana\b/.test(relative)) { dates.push(plusDays(base, 2)); relative = relative.replace(/\bpasado manana\b/g, ""); }
  if (/\bmanana\b/.test(relative)) dates.push(plusDays(base, 1));
  const fromToday = /\b(?:desde hoy|a partir de hoy|contados? desde hoy)\b/.test(value);
  if (/\b(?:desde|a partir de)\b/.test(value) && !fromToday && !/\b(?:desde|a partir de) (?:el )?vencimiento\b/.test(value)) return null;
  if (fromToday && days.length === 1) dates.push(plusDays(base, days[0]));
  else if (/\bhoy\b/.test(value) && !fromToday) dates.push(base);
  const uniqueDates = [...new Set(dates)];
  if (uniqueDates.length > 1) return null;
  const credit = folio(text);
  if (credit === null) return null;
  const bind = credit ? { folio: credit } : {};
  if (fromToday) return uniqueDates.length === 1 ? { kind: "date", date: uniqueDates[0], ...bind } : null;
  if (days.length === 1) return { kind: "days", days: days[0] as 1 | 2 | 3 | 4, ...(uniqueDates[0] ? { date: uniqueDates[0] } : {}), ...bind };
  return uniqueDates.length === 1 ? { kind: "date", date: uniqueDates[0], ...bind } : null;
}
/** Explicit personal request only. Merely asking about the policy is not consent. */
export function parseDianaExtensionRequest(text: string, at: string): DianaExtensionRequestIntent | null {
  return requestFrame(text) ? terms(text, at) : null;
}
function bareTerms(text: string, at: string) {
  const value = normalize(text).replace(/^[¿¡]|[?!.,;]+$/g, "").replace(/^(?:por favor[, ]*)|[, ]*por favor$/g, "").trim();
  if (new RegExp("^" + numberWord + "(?:\\s+dias?)?$").test(value)) {
    const count = number(value.split(" ")[0]);
    return [1, 2, 3, 4].includes(count) ? { kind: "days" as const, days: count as 1 | 2 | 3 | 4 } : null;
  }
  if (/^(?:(?:hasta|para)(?: el)?\s+)?(?:manana|pasado manana|hoy|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/.test(value)) return terms(value, at);
  return null;
}
function durationQuestion(text: string) {
  const value = normalize(text);
  return topic(value) && /\b(?:cuantos? dias|que fecha|hasta cuando|elige (?:entre )?(?:1|uno)|selecciona (?:los )?dias)\b/.test(value);
}
function creditQuestion(text: string) {
  const value = normalize(text);
  return /\b(?:que credito|cual credito|cual de (?:los|tus) creditos|indica (?:el )?folio|comparte (?:el )?folio)\b/.test(value);
}
/** Avoid walking old history for ordinary chat; this test never grants anything. */
export function mightBeDianaExtensionRequest(text: string, at: string) {
  const value = normalize(text);
  return topic(text) || bareTerms(text, at) !== null
    || /^(?:credito|folio)\s*[:#-]?\s*[a-z0-9._-]+[.!? ]*$/.test(value)
    || /^(?=[a-z0-9._-]*\d)[a-z0-9][a-z0-9._-]{0,119}$/.test(value);
}
function relevantLater(text: string, at: string) {
  const value = normalize(text);
  return cancelled(text) || topic(text) || bareTerms(text, at) !== null
    || new RegExp("\\b" + numberWord + "\\s+dias?\\b").test(value)
    || /\b(?:mejor|cambia|cambiar|corrijo|correccion|credito|folio)\b/.test(value)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(value);
}
/** Resolve a native target plus its complete current tail; ambiguity fails closed. */
export function resolveDianaExtensionRequest(targetId: string, messages: readonly DianaRequestContextMessage[]): DianaRequestResolution | null {
  const ordered = [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.id.localeCompare(b.id));
  const index = ordered.findIndex(message => message.id === targetId), target = ordered[index];
  if (!target || target.kind !== "lead" || target.direction !== "inbound" || quotedOrThirdParty(target.text) || cancelled(target.text)) return null;
  const targetAt = Date.parse(target.sentAt);
  if (!Number.isFinite(targetAt)) return null;
  // Native microseconds are normalized to milliseconds by the adapter. When
  // that loses ordering, a random UUID must never decide whether a cancellation
  // preceded the request or followed it.
  if (ordered.some(message => message.id !== target.id && Date.parse(message.sentAt) === targetAt)) return null;
  const prior = ordered.slice(0, index).filter(message => Date.parse(message.sentAt) >= targetAt - 15 * 60 * 1000).slice(-20);
  let intent = parseDianaExtensionRequest(target.text, target.sentAt);
  let evidenceIds = [target.id];
  const previous = prior.at(-1);
  if (!intent && previous?.kind === "agent" && previous.direction === "outbound") {
    if (prior.some((message, position) => position > 0 && Date.parse(message.sentAt) === Date.parse(prior[position - 1].sentAt))) return null;
    const earlier = prior.slice(0, -1).filter(message => message.kind === "lead" && message.direction === "inbound").at(-1);
    if (earlier && !cancelled(earlier.text) && !quotedOrThirdParty(earlier.text)) {
      if (durationQuestion(previous.text) && requestFrame(earlier.text)) {
        intent = bareTerms(target.text, target.sentAt);
        const credit = folio(earlier.text);
        if (credit === null) intent = null;
        else if (intent && credit) intent = { ...intent, folio: credit };
      } else if (creditQuestion(previous.text)) {
        const earlierIntent = parseDianaExtensionRequest(earlier.text, earlier.sentAt);
        const token = target.text.trim().replace(/[.,;!?]+$/, "");
        const credit = folio(target.text) || (/^(?=[a-z0-9._-]*\d)[a-z0-9][a-z0-9._-]{0,119}$/i.test(token) ? token : undefined);
        if (earlierIntent && credit) intent = { ...earlierIntent, folio: credit };
      }
      if (intent) evidenceIds = [earlier.id, previous.id, target.id];
    }
  }
  if (!intent) return null;
  // A later cancellation, revision or new request must be handled on its own event.
  if (ordered.slice(index + 1).some(message => message.kind === "lead" && message.direction === "inbound" && relevantLater(message.text, message.sentAt))) return null;
  return { intent, evidenceIds };
}
