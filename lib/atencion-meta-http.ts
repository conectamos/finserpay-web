import "server-only";
import { createHash } from "node:crypto";
import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import { META_ATTENTION_MAX_MEDIA_BYTES, validateMetaAttentionMedia } from "./atencion-meta";

/** Read bounded bytes before parsing multipart or verifying a webhook signature. */
export async function readAttentionBody(request: Request, maxBytes: number, timeoutMs = 20_000): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AttentionError("La solicitud excede el tamaño permitido.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AttentionError("Solicitud vacía.", 400);
  const parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); reject(new AttentionError("La carga tardó demasiado. Intenta nuevamente.", 408)); }, timeoutMs);
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (expired || request.signal.aborted) throw new AttentionError("La carga fue interrumpida.", 408);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AttentionError("La solicitud excede el tamaño permitido.", 413); }
      parts.push(part.value);
    }
    return Buffer.concat(parts, size);
  } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
}

export async function readAttentionMetaReply(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || contentType.length > 250) throw new AttentionError("Envía el mensaje y sus archivos como formulario.", 415);
  const bytes = await readAttentionBody(request, META_ATTENTION_MAX_MEDIA_BYTES + 65_536);
  let form: FormData;
  try { form = await new Response(Buffer.from(bytes), { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new AttentionError("No se pudo leer el formulario del mensaje.", 400); }
  const allowed = new Set(["requestId", "version", "text", "file"]);
  for (const key of form.keys()) if (!allowed.has(key) || form.getAll(key).length !== 1) throw new AttentionError("El formulario contiene campos repetidos o no admitidos.", 400);
  const requestId = attentionUuid(form.get("requestId"));
  const rawVersion = form.get("version");
  if (typeof rawVersion !== "string" || !/^[1-9]\d{0,8}$/.test(rawVersion)) throw new AttentionError("Versión de conversación inválida.", 400);
  const version = Number(rawVersion);
  const text = attentionText(form.get("text") ?? "", 4096, false);
  const file = form.get("file");
  if (file !== null && (typeof file === "string" || typeof file.arrayBuffer !== "function")) throw new AttentionError("Archivo inválido.", 400);
  if (!file) {
    if (!text) throw new AttentionError("Escribe un mensaje o adjunta un archivo.", 400);
    return { requestId, version, text, attachment: undefined, bytes: undefined };
  }
  const content = new Uint8Array(await file.arrayBuffer());
  const media = validateMetaAttentionMedia({ bytes: content, mimeType: file.type, fileName: file.name });
  if (text.length > 1024) throw new AttentionError("El texto de un archivo admite hasta 1.024 caracteres.", 400);
  if (["audio", "sticker"].includes(media.kind) && text) throw new AttentionError("Envía el audio o sticker sin texto adjunto.", 400);
  return { requestId, version, text,
    attachment: { kind: media.kind, mimeType: media.mimeType, fileName: file.name,
      size: media.size, sha256: createHash("sha256").update(content).digest("hex") }, bytes: content };
}
