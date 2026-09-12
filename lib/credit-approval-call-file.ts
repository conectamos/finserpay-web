import "server-only";
import { createHash } from "node:crypto";
import { parseBuffer } from "music-metadata";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

export const APPROVAL_CALL_MAX_BYTES = 10 * 1024 * 1024;
export const APPROVAL_CALL_MIME_TYPES = ["audio/mpeg", "audio/mp4", "audio/wav"] as const;
const invalid = () => new CreditApprovalError("INVALID_CALL_RECORDING", "Selecciona una grabación válida en MP3, M4A (AAC) o WAV (PCM).", 415);

function audioContainer(bytes: Buffer) {
  if (bytes.length < 16) throw invalid();
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE") {
    const end = bytes.readUInt32LE(4) + 8;
    if (end !== bytes.length) throw invalid();
    let data = false, pcm = false, offset = 12;
    while (offset + 8 <= end) {
      const kind = bytes.subarray(offset, offset + 4).toString();
      const size = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + size > end) throw invalid();
      if (kind === "fmt " && size >= 16) pcm = bytes.readUInt16LE(offset + 8) === 1;
      if (kind === "data" && size > 0) data = true;
      offset += 8 + size + (size % 2);
    }
    if (!data || !pcm || offset !== end) throw invalid();
    return "audio/wav" as const;
  }
  if (bytes.subarray(4, 8).toString() === "ftyp") {
    let offset = 0, media = false, movie = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.subarray(offset + 4, offset + 8).toString();
      let size = bytes.readUInt32BE(offset), header = 8;
      if (size === 1) {
        if (offset + 16 > bytes.length) throw invalid();
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(bytes.length)) throw invalid();
        size = Number(large); header = 16;
      }
      if (size === 0) size = bytes.length - offset;
      if (size < header || offset + size > bytes.length) throw invalid();
      if (kind === "mdat" && size > header) media = true;
      if (kind === "moov" && size > header) movie = true;
      offset += size;
    }
    if (!media || !movie || offset !== bytes.length) throw invalid();
    return "audio/mp4" as const;
  }
  if (bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return "audio/mpeg" as const;
  throw invalid();
}

export function approvalCallFileName(encoded: string | null) {
  let name: string;
  try { name = decodeURIComponent(encoded || ""); } catch { throw invalid(); }
  name = name.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/g, "_").trim();
  if (!name || name.length > 160 || !/\.(mp3|m4a|wav)$/i.test(name)) throw invalid();
  return name;
}

export async function prepareApprovalCallFile(bytes: Buffer, fileName: string) {
  if (!bytes.length) throw invalid();
  if (bytes.length > APPROVAL_CALL_MAX_BYTES) throw new CreditApprovalError("CALL_RECORDING_TOO_LARGE", "La grabación debe pesar como máximo 10 MB.", 413);
  const mimeType = audioContainer(bytes);
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  if (extension !== ({ "audio/wav": "wav", "audio/mp4": "m4a", "audio/mpeg": "mp3" }[mimeType])) throw invalid();
  try {
    // Use the verified container: phone M4A files may carry a 3GP brand.
    const { format } = await parseBuffer(bytes, { mimeType, size: bytes.length }, { duration: true, skipCovers: true, skipPostHeaders: true });
    if (!(Number.isFinite(format.duration) && format.duration! > 0) ||
        !(format.sampleRate! > 0) || !(format.numberOfChannels! > 0) || format.hasVideo ||
        (mimeType === "audio/mpeg" && (format.container !== "MPEG" || !/Layer 3$/.test(format.codec || ""))) ||
        (mimeType === "audio/mp4" && !/^MPEG-4\/AAC$/.test(format.codec || ""))) throw invalid();
  } catch { throw invalid(); }
  return { bytes, fileName, mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
