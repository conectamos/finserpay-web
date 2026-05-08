import { createHash } from "node:crypto";

const WOMPI_CHECKOUT_URL = "https://checkout.wompi.co/p/";
const WOMPI_PRODUCTION_API_URL = "https://production.wompi.co/v1";
const WOMPI_SANDBOX_API_URL = "https://sandbox.wompi.co/v1";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export function getWompiPublicKey() {
  return clean(process.env.WOMPI_PUBLIC_KEY);
}

export function getWompiPrivateKey() {
  return clean(process.env.WOMPI_PRIVATE_KEY || process.env.WOMPI_PRIV_KEY);
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

export function isWompiDirectApiConfigured() {
  return Boolean(
    getWompiPublicKey() && getWompiPrivateKey() && getWompiIntegritySecret()
  );
}

export function getWompiApiBaseUrl() {
  const configured = clean(process.env.WOMPI_API_BASE_URL).replace(/\/+$/, "");

  if (configured) {
    return configured;
  }

  return getWompiPrivateKey().startsWith("prv_test_")
    ? WOMPI_SANDBOX_API_URL
    : WOMPI_PRODUCTION_API_URL;
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

type WompiMerchantResponse = {
  data?: {
    presigned_acceptance?: {
      acceptance_token?: string;
      permalink?: string;
    };
    presigned_personal_data_auth?: {
      acceptance_token?: string;
      permalink?: string;
    };
  };
};

type WompiApiError = {
  error?: {
    messages?: unknown;
    reason?: string;
    type?: string;
  };
};

export type WompiNequiTransaction = {
  id?: string;
  reference?: string;
  status?: string;
  status_message?: string | null;
  payment_method_type?: string | null;
  [key: string]: unknown;
};

function extractWompiError(data: unknown, fallback: string) {
  const error = (data as WompiApiError | null)?.error;

  if (!error) {
    return fallback;
  }

  if (typeof error.reason === "string" && error.reason.trim()) {
    return error.reason.trim();
  }

  if (typeof error.messages === "string" && error.messages.trim()) {
    return error.messages.trim();
  }

  if (Array.isArray(error.messages) && error.messages.length) {
    return error.messages.map((item) => clean(item)).filter(Boolean).join(", ");
  }

  if (error.messages && typeof error.messages === "object") {
    return Object.entries(error.messages as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${clean(value)}`)
      .filter(Boolean)
      .join(", ");
  }

  return fallback;
}

export async function getWompiMerchantAcceptanceTokens() {
  const publicKey = getWompiPublicKey();

  if (!publicKey) {
    throw new Error("WOMPI_PUBLIC_KEY no esta configurada");
  }

  const response = await fetch(
    `${getWompiApiBaseUrl()}/merchants/${encodeURIComponent(publicKey)}`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    }
  );
  const data = (await response.json().catch(() => ({}))) as WompiMerchantResponse;

  if (!response.ok) {
    throw new Error(
      extractWompiError(data, "No se pudieron obtener los terminos de Wompi")
    );
  }

  const acceptanceToken = clean(data.data?.presigned_acceptance?.acceptance_token);
  const personalDataAcceptanceToken = clean(
    data.data?.presigned_personal_data_auth?.acceptance_token
  );

  if (!acceptanceToken || !personalDataAcceptanceToken) {
    throw new Error("Wompi no entrego los tokens de aceptacion");
  }

  return {
    acceptanceToken,
    acceptancePermalink: clean(data.data?.presigned_acceptance?.permalink),
    personalDataAcceptancePermalink: clean(
      data.data?.presigned_personal_data_auth?.permalink
    ),
    personalDataAcceptanceToken,
  };
}

export async function createWompiNequiTransaction(options: {
  amountInCents: number;
  customerDocument?: string | null;
  customerEmail: string;
  customerName?: string | null;
  nequiPhone: string;
  reference: string;
}) {
  const privateKey = getWompiPrivateKey();

  if (!privateKey) {
    throw new Error("WOMPI_PRIVATE_KEY no esta configurada");
  }

  const tokens = await getWompiMerchantAcceptanceTokens();
  const customerPhone = clean(options.nequiPhone).replace(/\D/g, "");
  const payload: Record<string, unknown> = {
    acceptance_token: tokens.acceptanceToken,
    accept_personal_auth: tokens.personalDataAcceptanceToken,
    amount_in_cents: options.amountInCents,
    currency: "COP",
    customer_email: options.customerEmail,
    payment_description: `FINSER PAY ${options.reference}`,
    payment_method: {
      type: "NEQUI",
      phone_number: customerPhone,
    },
    reference: options.reference,
    signature: buildWompiIntegritySignature({
      amountInCents: options.amountInCents,
      currency: "COP",
      reference: options.reference,
    }),
  };
  const legalId = clean(options.customerDocument).replace(/\D/g, "");
  const fullName = clean(options.customerName);

  if (legalId || fullName || customerPhone) {
    payload.customer_data = {
      ...(fullName ? { full_name: fullName } : {}),
      ...(legalId ? { legal_id: legalId, legal_id_type: "CC" } : {}),
      ...(customerPhone ? { phone_number: customerPhone } : {}),
    };
  }

  const response = await fetch(`${getWompiApiBaseUrl()}/transactions`, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${privateKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as {
    data?: WompiNequiTransaction;
  };

  if (!response.ok) {
    throw new Error(
      extractWompiError(data, "No se pudo crear la transaccion Nequi en Wompi")
    );
  }

  return (data.data || data) as WompiNequiTransaction;
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
