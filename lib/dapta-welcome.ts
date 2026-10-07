type CreditWelcome = {
  creditId: number;
  phone: string | null | undefined;
  name: string;
};

type WelcomeResult = "disabled" | "invalid_contact" | "accepted" | "failed";

function hasDaptaExecutionError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasDaptaExecutionError);
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (
    (typeof error === "string" && error.trim() !== "") ||
    error === true ||
    (error && typeof error === "object" && Object.keys(error).length > 0)
  ) return true;
  return Object.values(record).some(hasDaptaExecutionError);
}

export function normalizeColombianMobile(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  const phone = digits.length === 10 && digits.startsWith("3") ? `57${digits}` : digits;
  return /^573\d{9}$/.test(phone) ? phone : null;
}

export async function sendDaptaWelcome(
  credit: CreditWelcome,
  options: {
    enabled?: boolean;
    webhookUrl?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<WelcomeResult> {
  const enabled = options.enabled ?? process.env.DAPTA_BIENVENIDA_ENABLED === "true";
  const webhookUrl = options.webhookUrl ?? process.env.DAPTA_BIENVENIDA_WEBHOOK_URL;
  if (!enabled || !webhookUrl) return "disabled";

  // The URL contains Dapta's webhook credential. Never include it in logs.
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return "failed";
  }
  if (url.protocol !== "https:" || url.hostname !== "api.dapta.ai") return "failed";

  const phone = normalizeColombianMobile(credit.phone);
  const name = credit.name.trim().slice(0, 100);
  if (!phone || !name || !Number.isSafeInteger(credit.creditId) || credit.creditId < 1) {
    return "invalid_contact";
  }

  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credito_id: String(credit.creditId),
        telefono: phone,
        nombre: name,
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) return "failed";
    // Dapta can return HTTP 200 even when a flow node failed. Keep response
    // contents private; acceptance by the webhook is not delivery by WhatsApp.
    const payload: unknown = await response.json().catch(() => null);
    return hasDaptaExecutionError(payload) ? "failed" : "accepted";
  } catch {
    return "failed";
  }
}
