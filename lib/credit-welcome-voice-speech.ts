import { normalizeWelcomeVoiceDocument, normalizeWelcomeVoiceName } from "@/lib/credit-welcome-voice-core";

const small = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
  "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const tens = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const hundreds = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];
const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const maxInteger = 999_999_999_999;

function masculine(value: string): string {
  return value.replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");
}

function cardinal(value: number): string {
  if (value < 30) return small[value];
  if (value < 100) return tens[Math.floor(value / 10)] + (value % 10 ? ` y ${small[value % 10]}` : "");
  if (value === 100) return "cien";
  if (value < 1000) return hundreds[Math.floor(value / 100)] + (value % 100 ? ` ${cardinal(value % 100)}` : "");
  if (value < 1_000_000) {
    const thousands = Math.floor(value / 1000);
    return (thousands === 1 ? "mil" : `${masculine(cardinal(thousands))} mil`) + (value % 1000 ? ` ${cardinal(value % 1000)}` : "");
  }
  const millions = Math.floor(value / 1_000_000);
  return (millions === 1 ? "un millón" : `${masculine(cardinal(millions))} millones`)
    + (value % 1_000_000 ? ` ${cardinal(value % 1_000_000)}` : "");
}

export function welcomeVoiceIntegerSpoken(value: number): string | null {
  return Number.isSafeInteger(value) && value >= 0 && value <= maxInteger ? cardinal(value) : null;
}

export function welcomeVoiceMoneySpoken(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > maxInteger) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value - cents / 100) > 0.0000001) return null;
  const integer = Math.floor(cents / 100);
  const remainder = cents % 100;
  const whole = masculine(cardinal(integer));
  const unit = integer === 1 ? "peso" : integer > 0 && integer % 1_000_000 === 0 ? "de pesos" : "pesos";
  return `${whole} ${unit}` + (remainder ? ` con ${masculine(cardinal(remainder))} ${remainder === 1 ? "centavo" : "centavos"}` : "");
}

export function welcomeVoiceDateSpoken(value: string): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900) return null;
  return `${day === 1 ? "primero" : cardinal(day)} de ${months[month - 1]} de ${cardinal(year)}`;
}

export function welcomeVoiceDocumentSpoken(value: string): string | null {
  const document = normalizeWelcomeVoiceDocument(value);
  return document ? [...document].map(digit => small[Number(digit)]).join(", ") : null;
}

export function welcomeVoiceNameSpoken(value: string, expected: string): string | null {
  if (!normalizeWelcomeVoiceName(value) || normalizeWelcomeVoiceName(value) !== normalizeWelcomeVoiceName(expected)) return null;
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("es-CO").replace(/(^|[\s-])\p{L}/gu, letter => letter.toLocaleUpperCase("es-CO"));
}

export type WelcomeVoiceFinancialSpeech = {
  initialPayment: string; installmentAmount: string; installmentCount: string;
  firstDueDate: string; installmentAmounts: string[];
};

/** Spoken values are derived exclusively from the same verified financial snapshot. */
export function buildWelcomeVoiceFinancialSpeech(input: {
  initialPayment: number; installmentAmount: number; installmentCount: number;
  frequency: string; firstDueDate: string; installmentAmounts: number[];
}): WelcomeVoiceFinancialSpeech | null {
  const initialPayment = welcomeVoiceMoneySpoken(input.initialPayment);
  const installmentAmount = welcomeVoiceMoneySpoken(input.installmentAmount);
  const firstDueDate = welcomeVoiceDateSpoken(input.firstDueDate);
  const count = welcomeVoiceIntegerSpoken(input.installmentCount);
  const frequency = ({ QUINCENAL: "quincenal", MENSUAL: "mensual", CATORCENAL: "cada catorce días" } as Record<string, string>)[input.frequency];
  if (!initialPayment || !installmentAmount || !firstDueDate || !count || !frequency || input.installmentCount < 1
    || input.installmentCount > 1000 || !Array.isArray(input.installmentAmounts) || input.installmentAmounts.length !== input.installmentCount) return null;
  const installmentAmounts = input.installmentAmounts.map(welcomeVoiceMoneySpoken);
  if (input.installmentAmount <= 0 || input.installmentAmounts.some(amount => amount <= 0) || installmentAmounts.some(amount => !amount)) return null;
  const feminineCount = count.replace(/veintiuno$/, "veintiuna").replace(/uno$/, "una");
  const plural = input.installmentCount !== 1;
  const cadence = input.frequency === "CATORCENAL" ? frequency : plural ? `${frequency.slice(0, -2)}ales` : frequency;
  return { initialPayment, installmentAmount, firstDueDate, installmentAmounts: installmentAmounts as string[],
    installmentCount: `${feminineCount} ${plural ? "cuotas" : "cuota"} ${cadence}` };
}
