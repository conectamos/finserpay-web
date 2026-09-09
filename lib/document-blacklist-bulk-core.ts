import { blacklistReason, DocumentBlacklistError, normalizeBlacklistedDocument } from "@/lib/document-blacklist-core";

export const BULK_MAX_ENTRIES = 500;
export const BULK_MAX_TEXT_LENGTH = 50_000;

export type ParsedBulkRow = {
  position: number;
  input: string;
  documento: string | null;
  error: string | null;
  duplicateOf: number | null;
};

export type BulkInput = {
  texto: string;
  motivo: string;
  parsed: { rows: ParsedBulkRow[]; documentos: string[] };
};

export type BulkRow = {
  position: number;
  input: string;
  documento: string | null;
  status: "NUEVA" | "REACTIVAR" | "YA_BLOQUEADA" | "DUPLICADA" | "INVALIDA";
  message: string;
};

export type BulkSummary = {
  total: number;
  nuevas: number;
  reactivar: number;
  yaBloqueadas: number;
  duplicadas: number;
  invalidas: number;
};

export type BulkPreview = {
  rows: BulkRow[];
  summary: BulkSummary;
  fingerprint: string;
  canConfirm: boolean;
  maxEntries: number;
  motivo: string;
};

export type BulkResult = {
  importId: string;
  summary: BulkSummary;
  items: Array<{ documento: string; accion: "BLOQUEADA" | "REACTIVADA" | "OMITIDA" }>;
  createdAt: string;
  actorName: string;
  idempotent: boolean;
};

function splitBlacklistBulkText(value: string): string[] {
  const entries = value.split(/[\r\n,;\t]+/).map((item) => item.trim()).filter(Boolean);
  if (entries[0] && /^(?:c[eé]dula|documento|cc|c\.c\.)$/i.test(entries[0])) entries.shift();
  return entries;
}

export function countBlacklistBulkEntries(value: string): number {
  return splitBlacklistBulkText(value).length;
}

export function parseBlacklistBulkText(value: unknown): BulkInput["parsed"] {
  if (typeof value !== "string") throw new DocumentBlacklistError("BULK_INVALID_TEXT", "Pega las cédulas como una lista de texto.");
  if (value.length > BULK_MAX_TEXT_LENGTH) throw new DocumentBlacklistError("BULK_TEXT_TOO_LARGE", "La lista es demasiado larga. Divide el texto en lotes de hasta 500 entradas.", 413);
  // An optional one-column heading is useful when copying a column from Excel.
  const entries = splitBlacklistBulkText(value);
  if (!entries.length) throw new DocumentBlacklistError("BULK_EMPTY", "Pega al menos una cédula para previsualizar.");
  if (entries.length > BULK_MAX_ENTRIES) throw new DocumentBlacklistError("BULK_TOO_MANY_ENTRIES", `Puedes cargar hasta ${BULK_MAX_ENTRIES} entradas por lote, incluidas las repetidas.`, 413);
  const seen = new Map<string, number>();
  const rows = entries.map((input, index): ParsedBulkRow => {
    const position = index + 1;
    try {
      // Do not silently concatenate what looks like two separate CCs. Ordinary
      // grouping (e.g. 1 234 567 890) remains compatible with individual entry.
      if (/\d{4,}\s+\d{4,}/.test(input)) {
        throw new DocumentBlacklistError("BULK_AMBIGUOUS_DOCUMENT", "Separa cada cédula con salto de línea, coma o punto y coma; no con espacios.");
      }
      const documento = normalizeBlacklistedDocument(input);
      const duplicateOf = seen.get(documento) ?? null;
      if (duplicateOf === null) seen.set(documento, position);
      return { position, input, documento, error: null, duplicateOf };
    } catch (error) {
      if (!(error instanceof DocumentBlacklistError)) throw error;
      return { position, input, documento: null, error: error.message, duplicateOf: null };
    }
  });
  return { rows, documentos: [...seen.keys()].sort() };
}

export function parseBlacklistBulkInput(value: unknown): BulkInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentBlacklistError("INVALID_REQUEST", "La solicitud no es válida.");
  const body = value as Record<string, unknown>;
  const motivo = blacklistReason(body.motivo);
  const parsed = parseBlacklistBulkText(body.texto);
  return { texto: body.texto as string, motivo, parsed };
}
