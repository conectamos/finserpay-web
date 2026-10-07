export const APPROVAL_REQUEST_DOCUMENT_FIELDS = {
  "cedula-frente": ["contratoCedulaFrenteDataUrl", "cedulaFrenteDataUrl"],
  "cedula-posterior": ["contratoCedulaRespaldoDataUrl", "cedulaRespaldoDataUrl"],
  "selfie-cedula": ["iphoneSelfieCedulaDataUrl", "contratoSelfieDataUrl", "contratoFotoDataUrl"],
  "foto-entrega": ["fotoEntregaDataUrl"],
  "foto-remision": ["fotoRemisionDataUrl"],
} as const;

export type ApprovalRequestImageKey = keyof typeof APPROVAL_REQUEST_DOCUMENT_FIELDS;
export type ApprovalRequestDocumentKey = ApprovalRequestImageKey | "documento-firmado";

export function parseApprovalDraftRequestId(value: unknown): number | null {
  if (typeof value !== "string" || !/^D-[1-9]\d*$/.test(value)) return null;
  const id = Number(value.slice(2));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseApprovalRequestDocumentKey(value: unknown): ApprovalRequestDocumentKey | null {
  if (typeof value !== "string") return null;
  return value === "documento-firmado" || Object.hasOwn(APPROVAL_REQUEST_DOCUMENT_FIELDS, value)
    ? value as ApprovalRequestDocumentKey
    : null;
}

function decodeBase64(value: string): Buffer | null {
  const encoded = value.replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1
    || (encoded.includes("=") && encoded.length % 4 !== 0)) return null;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length && bytes.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "")
    ? bytes
    : null;
}

export type ApprovalRequestDocumentMedia = {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf";
  extension: "png" | "jpg" | "webp" | "gif" | "pdf";
};

export function decodeApprovalRequestDocument(
  value: unknown,
  key: ApprovalRequestDocumentKey,
): ApprovalRequestDocumentMedia | null {
  if (typeof value !== "string") return null;
  const stored = value.trim();
  if (key === "documento-firmado") {
    const bytes = decodeBase64(stored.replace(/^data:application\/pdf;base64,/i, ""));
    return bytes?.subarray(0, 5).equals(Buffer.from("%PDF-"))
      ? { bytes, contentType: "application/pdf", extension: "pdf" }
      : null;
  }

  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(stored);
  if (!match) return null;
  const bytes = decodeBase64(match[2]);
  if (!bytes) return null;
  const contentType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const valid = contentType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : contentType === "image/jpeg"
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : contentType === "image/webp"
        ? bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
        : ["GIF87a", "GIF89a"].some((signature) => bytes.subarray(0, 6).equals(Buffer.from(signature)));
  if (!valid) return null;
  return {
    bytes,
    contentType: contentType as ApprovalRequestDocumentMedia["contentType"],
    extension: contentType === "image/jpeg" ? "jpg" : contentType.slice(6) as "png" | "webp" | "gif",
  };
}
