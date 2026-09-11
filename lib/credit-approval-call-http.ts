import "server-only";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalPrivateHeaders, isSameApprovalOrigin } from "@/lib/credit-approval-http";
import { APPROVAL_CALL_MAX_BYTES, approvalCallFileName } from "@/lib/credit-approval-call-file";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function approvalCallId(value: string) {
  if (!uuid.test(value)) throw new CreditApprovalError("INVALID_CALL_RECORDING", "Grabación no válida.", 400);
  return value.toLowerCase();
}
export function approvalCallRequestHeaders(request: Request) {
  if (!isSameApprovalOrigin(request)) throw new CreditApprovalError("INVALID_ORIGIN", "La solicitud debe realizarse desde FINSER PAY.", 403);
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") {
    throw new CreditApprovalError("INVALID_CALL_RECORDING", "Envía el archivo de audio sin comprimir.", 415);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
    throw new CreditApprovalError("INVALID_CALL_RECORDING", "Selecciona y carga el archivo de audio.", 415);
  }
  const version = request.headers.get("x-review-revision") || "";
  const revision = Number(version);
  const reviewHash = request.headers.get("x-review-hash") || "";
  if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(revision) || revision > 2_147_483_647 || !/^[a-f0-9]{64}$/.test(reviewHash)) {
    throw new CreditApprovalError("INVALID_REVIEW", "Actualiza el expediente antes de cargar la grabación.", 400);
  }
  return { revision, reviewHash, fileName: approvalCallFileName(request.headers.get("x-recording-file-name")),
    idempotencyKey: approvalCallId(request.headers.get("idempotency-key") || "") };
}

/** Authenticate before calling. Bound actual bytes even with a missing or false Content-Length. */
export async function readApprovalCallBytes(request: Request) {
  const tooLarge = () => new CreditApprovalError("CALL_RECORDING_TOO_LARGE", "La grabación debe pesar como máximo 10 MB.", 413);
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > APPROVAL_CALL_MAX_BYTES)) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new CreditApprovalError("INVALID_CALL_RECORDING", "El archivo está vacío.", 400);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > APPROVAL_CALL_MAX_BYTES) { await reader.cancel(); throw tooLarge(); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  if (!total) throw new CreditApprovalError("INVALID_CALL_RECORDING", "El archivo está vacío.", 400);
  return Buffer.concat(chunks, total);
}

export function approvalCallAudioResponse(request: Request, recording: { bytes: Buffer; mimeType: string; fileName: string }) {
  const size = recording.bytes.length;
  const headers = { ...approvalPrivateHeaders, "Content-Type": recording.mimeType, "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename="grabacion.${recording.mimeType === "audio/mpeg" ? "mp3" : recording.mimeType === "audio/mp4" ? "m4a" : "wav"}"; filename*=UTF-8''${encodeURIComponent(recording.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}` };
  const range = request.headers.get("range");
  if (!range) return new Response(new Uint8Array(recording.bytes), { headers: { ...headers, "Content-Length": String(size) } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0, end = size - 1;
  if (match) {
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
  }
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      (!match[1] && Number(match[2]) === 0) || start >= size || start > end || start < 0) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
  }
  const body = recording.bytes.subarray(start, end + 1);
  return new Response(new Uint8Array(body), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(body.length) } });
}
