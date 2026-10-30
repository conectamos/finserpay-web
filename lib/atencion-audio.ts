import "server-only";
import { spawn } from "node:child_process";
import { AttentionError } from "./atencion-core";
import { readAttentionBody } from "./atencion-meta-http";
import { validateMetaAttentionMedia } from "./atencion-meta";

const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
let activeConversions = 0;

export async function readAttentionRecording(request: Request) {
  const type = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(type) || type.length > 250) throw new AttentionError("Grabación inválida.", 415);
  const raw = await readAttentionBody(request, MAX_RECORDING_BYTES + 4096);
  let form: FormData;
  try { form = await new Response(Buffer.from(raw), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new AttentionError("No se pudo leer la grabación.", 400); }
  if ([...form.keys()].some(key => key !== "file") || form.getAll("file").length !== 1) throw new AttentionError("Adjunta una única grabación.");
  const file = form.get("file");
  if (!file || typeof file === "string" || file.type.split(";")[0] !== "audio/webm") throw new AttentionError("El formato de la grabación no es válido.", 415);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RECORDING_BYTES) throw new AttentionError("El audio supera el límite de 8 MB.", 413);
  if (bytes.length < 16 || ![0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)) throw new AttentionError("El contenido no corresponde a una grabación WebM.", 415);
  return bytes;
}

/** In-memory, bounded conversion. Only the WebM demuxer and pipe protocol are allowed. */
export async function convertAttentionRecording(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new AttentionError("Grabación cancelada.", 408);
  if (activeConversions >= 2) throw new AttentionError("Hay otros audios en preparación. Intenta de nuevo en unos segundos.", 429);
  activeConversions++;
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
        "-protocol_whitelist", "pipe", "-f", "matroska", "-i", "pipe:0", "-map", "0:a:0", "-vn",
        "-t", "300", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-threads", "1", "-f", "ogg", "pipe:1"],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const parts: Buffer[] = []; let size = 0; let settled = false;
      const finish = (error?: AttentionError) => {
        if (settled) return; settled = true;
        clearTimeout(timeout); signal?.removeEventListener("abort", abort);
        if (error) { child.kill("SIGKILL"); reject(error); return; }
        try {
          const output = Buffer.concat(parts, size);
          validateMetaAttentionMedia({ bytes: output, mimeType: "audio/ogg", fileName: "audio.ogg" });
          resolve(output);
        } catch { reject(new AttentionError("No se pudo preparar el audio. Grábalo nuevamente.", 415)); }
      };
      const abort = () => finish(new AttentionError("Grabación cancelada.", 408));
      const timeout = setTimeout(() => finish(new AttentionError("La preparación del audio tardó demasiado. Intenta con una grabación más corta.", 408)), 45_000);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (part: Buffer) => {
        size += part.length;
        if (size > MAX_RECORDING_BYTES) finish(new AttentionError("El audio supera el tamaño permitido.", 413));
        else parts.push(part);
      });
      // Drain stderr without logging user recordings or codec payloads.
      child.stderr.resume(); child.stdin.on("error", () => undefined);
      child.on("error", () => finish(new AttentionError("La preparación de audios no está disponible. Puedes adjuntar un audio MP3, M4A u OGG.", 503)));
      child.on("close", code => finish(code === 0 ? undefined : new AttentionError("No se pudo leer la grabación. Grábala nuevamente.", 415)));
      child.stdin.end(bytes);
    });
  } finally { activeConversions--; }
}
