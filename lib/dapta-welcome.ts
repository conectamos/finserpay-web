type CreditWelcome = {
  creditId: number;
  phone: string | null | undefined;
  name: string;
};

type WelcomeResult = "disabled" | "invalid_contact" | "sent" | "failed";

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
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
