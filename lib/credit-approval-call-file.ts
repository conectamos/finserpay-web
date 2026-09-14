import "server-only";
import { createHash } from "node:crypto";
import { parseBuffer } from "music-metadata";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

export const APPROVAL_CALL_MAX_BYTES = 10 * 1024 * 1024;
export const APPROVAL_CALL_MIME_TYPES = ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav"] as const;
const invalid = () => new CreditApprovalError("INVALID_CALL_RECORDING", "Selecciona una grabación válida en MP3, M4A, MP4 de audio (AAC), OGG (Opus) o WAV (PCM).", 415);

const OGG_CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = ((crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
  return crc;
});

function oggChecksum(bytes: Buffer, start: number, end: number) {
  let crc = 0;
  for (let index = start; index < end; index++) {
    const value = index >= start + 22 && index < start + 26 ? 0 : bytes[index];
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ value) & 0xff]) >>> 0;
  }
  return crc;
}

function validateOpusHead(packet: Buffer) {
  if (packet.length < 19 || packet.subarray(0, 8).toString() !== "OpusHead" || packet[8] !== 1) throw invalid();
  const channels = packet[9];
  const mappingFamily = packet[18];
  if (channels === 0) throw invalid();
  if (mappingFamily === 0) {
    if (channels > 2 || packet.length !== 19) throw invalid();
    return;
  }
  if (packet.length !== 21 + channels) throw invalid();
  const streams = packet[19];
  const coupledStreams = packet[20];
  if (streams === 0 || coupledStreams > streams || streams + coupledStreams > 255 ||
      (mappingFamily === 1 && channels > 8)) throw invalid();
  for (let index = 0; index < channels; index++) {
    const mapping = packet[21 + index];
    if (mapping !== 255 && mapping >= streams + coupledStreams) throw invalid();
  }
}

function validateOggOpus(bytes: Buffer) {
  let offset = 0;
  let serial: number | undefined;
  let expectedSequence = 0;
  let continuedPacket = false;
  let sawPage = false;
  let sawEnd = false;
  let packetIndex = 0;
  let packetLength = 0;
  const commentPrefix: number[] = [];
  while (offset < bytes.length) {
    if (sawEnd || offset + 27 > bytes.length || bytes.subarray(offset, offset + 4).toString() !== "OggS" || bytes[offset + 4] !== 0) throw invalid();
    const flags = bytes[offset + 5];
    const segmentCount = bytes[offset + 26];
    const headerEnd = offset + 27 + segmentCount;
    if ((flags & ~0x07) !== 0 || headerEnd > bytes.length) throw invalid();
    let bodyLength = 0;
    for (let index = offset + 27; index < headerEnd; index++) bodyLength += bytes[index];
    const end = headerEnd + bodyLength;
    if (end > bytes.length || oggChecksum(bytes, offset, end) !== bytes.readUInt32LE(offset + 22)) throw invalid();
    const pageSerial = bytes.readUInt32LE(offset + 14);
    const pageSequence = bytes.readUInt32LE(offset + 18);
    if (!sawPage) {
      if ((flags & 0x02) === 0 || (flags & 0x01) !== 0 || pageSequence !== 0 || segmentCount === 0) throw invalid();
      serial = pageSerial;
    } else if ((flags & 0x02) !== 0 || pageSerial !== serial || pageSequence !== expectedSequence || Boolean(flags & 0x01) !== continuedPacket) {
      throw invalid();
    }
    let bodyOffset = headerEnd;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      const segmentLength = bytes[offset + 27 + segmentIndex];
      if (packetIndex === 1 && commentPrefix.length < 8) {
        const prefixLength = Math.min(segmentLength, 8 - commentPrefix.length);
        for (let index = 0; index < prefixLength; index++) commentPrefix.push(bytes[bodyOffset + index]);
      }
      packetLength += segmentLength;
      bodyOffset += segmentLength;
      if (segmentLength < 255) {
        if (packetIndex === 0) {
          if (sawPage || segmentIndex !== segmentCount - 1) throw invalid();
          validateOpusHead(bytes.subarray(headerEnd, headerEnd + packetLength));
        } else if (packetIndex === 1) {
          if (commentPrefix.length !== 8 || Buffer.from(commentPrefix).toString() !== "OpusTags" || segmentIndex !== segmentCount - 1) throw invalid();
        }
        packetIndex++;
        packetLength = 0;
      }
    }
    if (!sawPage && (packetIndex !== 1 || packetLength !== 0)) throw invalid();
    if (segmentCount > 0) continuedPacket = bytes[headerEnd - 1] === 255;
    if ((flags & 0x04) !== 0) sawEnd = true;
    sawPage = true;
    expectedSequence = (pageSequence + 1) >>> 0;
    offset = end;
  }
  if (!sawPage || packetIndex < 2 || continuedPacket || offset !== bytes.length) throw invalid();
}

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
  if (bytes.subarray(0, 4).toString() === "OggS") {
    validateOggOpus(bytes);
    return "audio/ogg" as const;
  }
  if (bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return "audio/mpeg" as const;
  throw invalid();
}

export function approvalCallFileName(encoded: string | null) {
  let name: string;
  try { name = decodeURIComponent(encoded || ""); } catch { throw invalid(); }
  name = name.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/g, "_").trim();
  if (!name || name.length > 160 || !/\.(mp3|m4a|mp4|ogg|wav)$/i.test(name)) throw invalid();
  return name;
}

export async function prepareApprovalCallFile(bytes: Buffer, fileName: string) {
  if (!bytes.length) throw invalid();
  if (bytes.length > APPROVAL_CALL_MAX_BYTES) throw new CreditApprovalError("CALL_RECORDING_TOO_LARGE", "La grabación debe pesar como máximo 10 MB.", 413);
  const mimeType = audioContainer(bytes);
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const validExtension = mimeType === "audio/mp4"
    ? extension === "m4a" || extension === "mp4"
    : extension === ({ "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" }[mimeType]);
  if (!validExtension) throw invalid();
  try {
    // Use the verified container: phone M4A files may carry a 3GP brand.
    const { format } = await parseBuffer(bytes, { mimeType, size: bytes.length }, { duration: true, skipCovers: true, skipPostHeaders: true });
    if (!(Number.isFinite(format.duration) && format.duration! > 0) ||
        !(format.sampleRate! > 0) || !(format.numberOfChannels! > 0) || format.hasVideo ||
        (mimeType === "audio/mpeg" && (format.container !== "MPEG" || !/Layer 3$/.test(format.codec || ""))) ||
        (mimeType === "audio/mp4" && !/^MPEG-4\/AAC$/.test(format.codec || "")) ||
        (mimeType === "audio/ogg" && (format.container !== "Ogg" || format.codec !== "Opus" || format.hasAudio !== true))) throw invalid();
  } catch { throw invalid(); }
  return { bytes, fileName, mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
