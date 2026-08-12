import sharp from "sharp";

const MAX_DELIVERY_EVIDENCE_DATA_URL_LENGTH = 2_500_000;
const MAX_DELIVERY_EVIDENCE_PIXELS = 12_000_000;
const MAX_DELIVERY_EVIDENCE_SIDE = 6_000;

function decodeCanonicalBase64(value: string) {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    return null;
  }

  const buffer = Buffer.from(value, "base64");

  return buffer.length > 0 && buffer.toString("base64") === value
    ? buffer
    : null;
}
function hasBytesAt(buffer: Buffer, offset: number, expected: number[]) {
  return expected.every((byte, index) => buffer[offset + index] === byte);
}

function hasCompletePdfCompatibleImage(
  format: "png" | "jpg" | "jpeg",
  buffer: Buffer
) {
  if (format === "png") {
    return (
      buffer.length >= 45 &&
      hasBytesAt(buffer, 0, [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]) &&
      hasBytesAt(buffer, 12, [0x49, 0x48, 0x44, 0x52]) &&
      hasBytesAt(buffer, buffer.length - 12, [
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
    );
  }

  return (
    buffer.length >= 32 &&
    hasBytesAt(buffer, 0, [0xff, 0xd8, 0xff]) &&
    hasBytesAt(buffer, buffer.length - 2, [0xff, 0xd9])
  );
}

/**
 * Validates the two iPhone delivery photos with a real decoder. The accepted
 * formats intentionally match PDFKit's native image support.
 */
export async function sanitizeIphoneDeliveryEvidenceDataUrl(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (
    !normalized ||
    normalized.length > MAX_DELIVERY_EVIDENCE_DATA_URL_LENGTH
  ) {
    return "";
  }

  const match = normalized.match(
    /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/]*={0,2})$/i
  );

  if (!match) {
    return "";
  }

  const imageBuffer = decodeCanonicalBase64(match[2]);

  if (!imageBuffer) {
    return "";
  }
  const requestedFormat = match[1].toLowerCase() as "png" | "jpg" | "jpeg";

  if (!hasCompletePdfCompatibleImage(requestedFormat, imageBuffer)) {
    return "";
  }


  try {
    const image = sharp(imageBuffer, {
      failOn: "error",
      limitInputPixels: MAX_DELIVERY_EVIDENCE_PIXELS,
    });
    const metadata = await image.metadata();
    const expectedFormat = requestedFormat === "png" ? "png" : "jpeg";
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);

    if (
      metadata.format !== expectedFormat ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_DELIVERY_EVIDENCE_SIDE ||
      height > MAX_DELIVERY_EVIDENCE_SIDE ||
      width * height > MAX_DELIVERY_EVIDENCE_PIXELS
    ) {
      return "";
    }

    // metadata() validates the header; decoding every pixel also rejects
    // truncated/corrupt files and decompression bombs before persistence.
    await image.clone().raw().toBuffer();

    return normalized;
  } catch {
    return "";
  }
}
