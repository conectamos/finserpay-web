const digitWords: Readonly<Record<string, string>> = {
  cero: "0", uno: "1", dos: "2", tres: "3", cuatro: "4",
  cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9",
};
const smallCardinals: Readonly<Record<string, number>> = {
  cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const tens: Readonly<Record<string, number>> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};
const hundreds: Readonly<Record<string, number>> = {
  doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500,
  seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
};
function lookup<T>(table: Readonly<Record<string, T>>, word: string): T | undefined {
  return Object.hasOwn(table, word) ? table[word] : undefined;
}

function expandDoubleDigitWords(value: string): string | null {
  const words = value.split(" ");
  const expanded: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word !== "doble") {
      expanded.push(word);
      continue;
    }
    // Only an explicit single spoken digit may repeat, within this same block.
    const digit = words[index + 1];
    if (lookup(digitWords, digit) === undefined) return null;
    expanded.push(digit, digit);
    index++;
  }
  return expanded.join(" ");
}

function underOneHundred(words: string[]): number | null {
  if (words.length === 1) return lookup(smallCardinals, words[0]) ?? lookup(tens, words[0]) ?? null;
  const ten = lookup(tens, words[0]);
  const unit = lookup(digitWords, words[2]);
  return words.length === 3 && ten !== undefined && words[1] === "y" && unit !== undefined && unit !== "0"
    ? ten + Number(unit) : null;
}

function cardinalBlock(words: string[]): number | null {
  if (words.length === 1 && words[0] === "cien") return 100;
  const hundred = words[0] === "ciento" ? 100 : lookup(hundreds, words[0]);
  if (hundred === undefined) return underOneHundred(words);
  if (words.length === 1) return words[0] === "ciento" ? null : hundred;
  const remainder = underOneHundred(words.slice(1));
  return remainder !== null && remainder > 0 ? hundred + remainder : null;
}

function spokenBlock(value: string): string | null {
  // Numeric/spoken blocks cannot mix within a block; its boundary must be explicit.
  if (/^\d{1,3}$/.test(value)) return value;
  if (!/^[a-z]+(?: [a-z]+)*$/.test(value)) return null;
  const words = value.split(" ");
  if (words.every(word => lookup(digitWords, word) !== undefined)) return words.map(word => lookup(digitWords, word)).join("");
  let zeroes = 0;
  while (words[zeroes] === "cero") zeroes++;
  const number = cardinalBlock(words.slice(zeroes));
  return number === null ? null : "0".repeat(zeroes) + String(number);
}

function unambiguousSpokenBlock(value: string): string | null {
  const whole = spokenBlock(value);
  if (whole !== null) return whole;
  if (!/^[a-z]+(?: [a-z]+)*$/.test(value)) return null;
  const words = value.split(" ");
  // A missing "y" or "ciento" could change the number, not merely its grouping.
  for (let index = 0; index < words.length - 1; index++) {
    const unit = lookup(digitWords, words[index + 1]);
    const isTen = words[index] === "veinte" || lookup(tens, words[index]) !== undefined;
    if ((isTen && unit !== undefined && unit !== "0") || words[index] === "cien") return null;
  }
  // Keep at most two distinct outputs at each boundary: two prove ambiguity.
  // No expected document or desired length participates in choosing a parse.
  const outputs: Set<string>[] = Array.from({ length: words.length + 1 }, () => new Set<string>());
  outputs[words.length].add("");
  for (let start = words.length - 1; start >= 0; start--) {
    for (let end = start + 1; end <= words.length && outputs[start].size < 2; end++) {
      const prefix = spokenBlock(words.slice(start, end).join(" "));
      if (prefix === null) continue;
      for (const suffix of outputs[end]) {
        outputs[start].add(prefix + suffix);
        if (outputs[start].size === 2) break;
      }
    }
  }
  return outputs[0].size === 1 ? outputs[0].values().next().value ?? null : null;
}

function numericDocument(value: string): string | null {
  if (value.includes(".") && value.includes(",")) return null;
  // Dots/commas mean grouping only when all trailing groups contain three digits.
  // A fractional-looking value must not be silently changed into a document.
  const groups = value.split(/[ -]/);
  if (groups.some(group => !/^\d+$/.test(group) && !/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/.test(group))) return null;
  return groups.map(group => group.replace(/[.,]/g, "")).join("");
}

/** Parse only the document actually spoken during the welcome call, without an expected value. */
export function parseWelcomeVoiceSpokenDocument(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 240 || /[\p{Cc}\p{Cf}]/u.test(raw)) return null;
  const value = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CO").trim().replace(/\s+/g, " ").replace(/[.!?…]+$/u, "").trim();
  if (!value) return null;
  let document: string | null;
  if (/^[\d .,-]+$/.test(value)) {
    document = numericDocument(value);
  } else {
    const blocks = value.split(/[,;]/).map(block => block.trim());
    const parsed = blocks.map(block => {
      const expanded = expandDoubleDigitWords(block);
      return expanded === null ? null : unambiguousSpokenBlock(expanded);
    });
    document = parsed.some(block => block === null) ? null : parsed.join("");
  }
  return document !== null && /^\d{5,15}$/.test(document) ? document : null;
}

/** A completion control never supplies, repairs or selects any document digits. */
export function parseWelcomeVoiceDocumentDictation(raw: unknown): { document: string | null; complete: boolean } {
  if (typeof raw !== "string" || raw.length > 240 || /[\p{Cc}\p{Cf}]/u.test(raw)) {
    return { document: null, complete: false };
  }
  const value = raw.normalize("NFC").trim();
  const completed = /^(.*?)(?:\s*[,.;]\s*|\s+)termin[eé][.,;!?…]*$/iu.exec(value);
  if (!completed || !completed[1].trim()) {
    return { document: parseWelcomeVoiceSpokenDocument(raw), complete: false };
  }
  return { document: parseWelcomeVoiceSpokenDocument(completed[1]), complete: true };
}
