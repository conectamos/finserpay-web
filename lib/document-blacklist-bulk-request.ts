import { DocumentBlacklistError } from "@/lib/document-blacklist-core";

export const BLACKLIST_BULK_MAX_BODY_BYTES = 150_000;

/** Bound the actual stream as well as Content-Length, including chunked requests. */
export async function readBlacklistBulkJson(request: Request): Promise<unknown> {
  const tooLarge = () => new DocumentBlacklistError("BULK_BODY_TOO_LARGE", "La lista es demasiado grande. Divide la carga en lotes de hasta 500 cédulas.", 413);
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > BLACKLIST_BULK_MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) throw new DocumentBlacklistError("INVALID_REQUEST", "La solicitud no es válida.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BLACKLIST_BULK_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof DocumentBlacklistError) throw error;
    throw new DocumentBlacklistError("INVALID_REQUEST", "La solicitud no es válida.");
  } finally {
    reader.releaseLock();
  }
}
