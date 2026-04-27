import { createHash } from "node:crypto";

const WOMPI_CHECKOUT_URL = "https://checkout.wompi.co/p/";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export function getWompiPublicKey() {
  return clean(process.env.WOMPI_PUBLIC_KEY);
}

export function getWompiIntegritySecret() {
  return clean(
    process.env.WOMPI_INTEGRITY_SECRET ||
      process.env.WOMPI_INTEGRITY_KEY ||
      process.env.WOMPI_SIGNATURE_SECRET
  );
}

export function getWompiEventsSecret() {
  return clean(
    process.env.WOMPI_EVENTS_SECRET ||
      process.env.WOMPI_EVENT_SECRET ||
      process.env.WOMPI_WEBHOOK_SECRET
  );
}

export function isWompiConfigured() {
  return Boolean(getWompiPublicKey() && getWompiIntegritySecret());
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildWompiIntegritySignature(options: {
  amountInCents: number;
  currency: string;
  reference: string;
}) {
  const secret = getWompiIntegritySecret();

  if (!secret) {
    throw new Error("WOMPI_INTEGRITY_SECRET no esta configurado");
  }

  return sha256Hex(
    `${options.reference}${options.amountInCents}${options.currency}${secret}`
  );
}

export function buildWompiCheckoutUrl(options: {
  amountInCents: number;
  customerDocument?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  redirectUrl?: string | null;
  reference: string;
}) {
  const publicKey = getWompiPublicKey();

  if (!publicKey) {
    throw new Error("WOMPI_PUBLIC_KEY no esta configurada");
  }

  const currency = "COP";
  const url = new URL(WOMPI_CHECKOUT_URL);
  url.searchParams.set("public-key", publicKey);
  url.searchParams.set("currency", currency);
  url.searchParams.set("amount-in-cents", String(options.amountInCents));
  url.searchParams.set("reference", options.reference);
  url.searchParams.set(
    "signature:integrity",
    buildWompiIntegritySignature({
      amountInCents: options.amountInCents,
      currency,
      reference: options.reference,
    })
  );

  if (options.redirectUrl) {
    url.searchParams.set("redirect-url", options.redirectUrl);
  }

  if (options.customerEmail) {
    url.searchParams.set("customer-data:email", options.customerEmail);
  }

  if (options.customerName) {
    url.searchParams.set("customer-data:full-name", options.customerName);
  }

  if (options.customerPhone) {
    url.searchParams.set("customer-data:phone-number", options.customerPhone);
    url.searchParams.set("customer-data:phone-number-prefix", "+57");
  }

  if (options.customerDocument) {
    url.searchParams.set("customer-data:legal-id", options.customerDocument);
    url.searchParams.set("customer-data:legal-id-type", "CC");
  }

  return url.toString();
}

function getPathValue(source: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, source);
}

export function validateWompiEventSignature(event: {
  data?: unknown;
  signature?: {
    checksum?: string;
    properties?: string[];
  };
  timestamp?: number | string;
}) {
  const secret = getWompiEventsSecret();

  if (!secret) {
    throw new Error("WOMPI_EVENTS_SECRET no esta configurado");
  }

  const properties = Array.isArray(event.signature?.properties)
    ? event.signature.properties
    : [];
  const checksum = clean(event.signature?.checksum).toLowerCase();

  if (!properties.length || !checksum) {
    return false;
  }

  const concatenated = properties
    .map((property) => clean(getPathValue(event.data, property)))
    .join("");
  const expected = sha256Hex(`${concatenated}${event.timestamp}${secret}`).toLowerCase();

  return expected === checksum;
}
