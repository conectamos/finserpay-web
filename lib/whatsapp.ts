export type WhatsAppOtpResult = {
  code: string;
  messageId: string | null;
  recipient: string;
  mode: "template" | "text";
};

type WhatsAppErrorPayload = {
  error?: {
    code?: number;
    error_data?: {
      details?: string;
    };
    error_subcode?: number;
    message?: string;
    type?: string;
  };
};

export class WhatsAppApiError extends Error {
  code?: number;
  status: number;
  details: string;

  constructor(message: string, status: number, details = "", code?: number) {
    super(message);
    this.name = "WhatsAppApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new WhatsAppApiError(`Falta configurar ${name}`, 500);
  }

  return value;
}

export function normalizeWhatsAppRecipient(value: unknown) {
  let digits = String(value ?? "").replace(/\D/g, "");

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.length === 10 && digits.startsWith("3")) {
    digits = `57${digits}`;
  }

  if (digits.length === 12 && digits.startsWith("57")) {
    return digits;
  }

  if (/^[1-9]\d{7,14}$/.test(digits)) {
    return digits;
  }

  return "";
}

export function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function buildOtpPayload(recipient: string, code: string) {
  const templateName = process.env.WHATSAPP_OTP_TEMPLATE_NAME?.trim();
  const languageCode =
    process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() ||
    process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE?.trim() ||
    "es_CO";

  if (templateName) {
    return {
      mode: "template" as const,
      payload: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: code,
                },
              ],
            },
          ],
        },
      },
    };
  }

  return {
    mode: "text" as const,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: false,
        body: [
          "FINSER PAY",
          `Codigo de validacion del contrato: ${code}`,
          "No compartas este codigo con terceros.",
        ].join("\n"),
      },
    },
  };
}

export async function sendWhatsAppOtp(phone: unknown): Promise<WhatsAppOtpResult> {
  const accessToken = getRequiredEnv("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = getRequiredEnv("WHATSAPP_PHONE_NUMBER_ID");
  const graphApiVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v25.0";
  const recipient = normalizeWhatsAppRecipient(phone);

  if (!recipient) {
    throw new WhatsAppApiError(
      "Numero de WhatsApp invalido. Usa un celular colombiano o incluye indicativo.",
      400
    );
  }

  const code = generateOtpCode();
  const { mode, payload } = buildOtpPayload(recipient, code);
  const response = await fetch(
    `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  const data = (await response.json().catch(() => ({}))) as
    | (WhatsAppErrorPayload & {
        messages?: Array<{ id?: string }>;
      })
    | null;

  if (!response.ok) {
    const apiMessage = data?.error?.message || "WhatsApp no acepto el envio";
    const apiDetails = data?.error?.error_data?.details || "";
    const apiCode = data?.error?.code;
    const friendlyMessage =
      apiCode === 133010
        ? "El numero de WhatsApp Business aun no esta registrado para Cloud API. En Meta debe aparecer conectado, no 'Sin conexion'."
        : apiMessage;

    throw new WhatsAppApiError(
      friendlyMessage,
      response.status,
      apiDetails || apiMessage,
      apiCode
    );
  }

  return {
    code,
    messageId: data?.messages?.[0]?.id || null,
    recipient,
    mode,
  };
}
