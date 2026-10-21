import { normalizeWhatsAppRecipient } from "@/lib/whatsapp";

export const SETTLEMENT_EMAIL_FROM = "FINSER PAY <pagos@finserpay.com>";
export const SETTLEMENT_WHATSAPP_SENDER = "573124085562";
// This exact body must be approved in Meta with a DOCUMENT header. Comparing
// approved content prevents an unrelated or edited payment-confirmation template.
export const SETTLEMENT_WHATSAPP_TEMPLATE_BODY =
  "Hola {{1}}. Adjuntamos tu liquidación FINSER PAY del {{2}} al {{3}}. " +
  "Valor neto de la liquidación: {{4}}. Este documento informa la liquidación generada y no confirma un desembolso.";

export class DeliveryProviderError extends Error {
  constructor(message: string, public readonly uncertain = false) {
    super(message);
    this.name = "DeliveryProviderError";
  }
}

export type SettlementDeliveryInput = {
  channel: "EMAIL" | "WHATSAPP";
  attemptId: string;
  recipient: string;
  subject: string;
  text: string;
  allyName: string;
  periodStart: string;
  periodEnd: string;
  netAmount: string;
  pdf: Buffer;
  filename: string;
};

type Options = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; beforeSend?: () => Promise<void> };
type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d{5,30}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SINGLE_EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function required(env: NodeJS.ProcessEnv, key: string, pattern?: RegExp): string {
  const value = env[key]?.trim() || "";
  if (!value || value.length > 4096 || CONTROL_CHARACTERS.test(value) || (pattern && !pattern.test(value))) {
    throw new DeliveryProviderError(`Falta configurar ${key} con un valor válido.`);
  }
  return value;
}

function normalizeTemplateText(value: unknown) {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
}

function validateInput(input: SettlementDeliveryInput) {
  if (!UUID.test(input.attemptId)) throw new DeliveryProviderError("El identificador del intento no es válido.");
  if (!["EMAIL", "WHATSAPP"].includes(input.channel)) throw new DeliveryProviderError("Canal de envío inválido.");
  if (!Buffer.isBuffer(input.pdf) || input.pdf.length < 5 || input.pdf.length > 20 * 1024 * 1024 ||
    input.pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new DeliveryProviderError("El PDF de la liquidación no es válido o excede 20 MiB.");
  }
  if (!/^[a-zA-Z0-9_.-]{1,150}\.pdf$/i.test(input.filename)) {
    throw new DeliveryProviderError("El nombre del PDF de la liquidación no es válido.");
  }
  for (const value of [input.allyName, input.periodStart, input.periodEnd, input.netAmount, input.subject]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512 || CONTROL_CHARACTERS.test(value)) {
      throw new DeliveryProviderError("Los datos del mensaje de liquidación no son válidos.");
    }
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 10_000) {
    throw new DeliveryProviderError("El contenido del correo de liquidación no es válido.");
  }
  if (input.channel === "EMAIL" && (input.recipient.length > 254 || !SINGLE_EMAIL.test(input.recipient))) {
    throw new DeliveryProviderError("Falta un correo válido del aliado.");
  }
  if (input.channel === "WHATSAPP" && (!/^\+?[\d ()-]{8,25}$/.test(input.recipient) ||
    !normalizeWhatsAppRecipient(input.recipient))) {
    throw new DeliveryProviderError("Falta un teléfono de WhatsApp válido del aliado.");
  }
}

/** Only outbound message requests cross the ambiguity boundary, never preflights
 * or media uploads. Provider text is deliberately excluded from stored errors. */
async function providerRequest(
  fetcher: typeof fetch, url: string, init: RequestInit,
  stage: string, messaging = false,
): Promise<RecordValue> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new DeliveryProviderError(`${stage}: no se pudo confirmar la respuesta del proveedor.`, messaging);
  }
  if (!response.ok) {
    const uncertain = messaging && (response.status >= 500 || response.status === 408 || response.status === 409);
    throw new DeliveryProviderError(`${stage}: el proveedor respondió HTTP ${response.status}.`, uncertain);
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new DeliveryProviderError(`${stage}: respuesta del proveedor inválida.`, messaging); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryProviderError(`${stage}: respuesta del proveedor inválida.`, messaging);
  }
  return value as RecordValue;
}

async function sendEmail(input: SettlementDeliveryInput, options: Options, env: NodeJS.ProcessEnv, fetcher: typeof fetch) {
  const key = required(env, "RESEND_API_KEY");
  const domainId = required(env, "RESEND_SETTLEMENT_DOMAIN_ID", UUID);
  const headers = { Authorization: `Bearer ${key}` };
  const domain = await providerRequest(fetcher, `https://api.resend.com/domains/${domainId}`, { headers }, "Verificación de Resend");
  if (domain.id !== domainId || domain.name !== "finserpay.com" || domain.status !== "verified" ||
    asRecord(domain.capabilities).sending !== "enabled") {
    throw new DeliveryProviderError("Resend debe verificar finserpay.com con envío habilitado para pagos@finserpay.com.");
  }
  // Fixed field order and persisted input make retries byte-identical. Resend's
  // key lasts 24h: the dispatcher must not blindly retry old ambiguous attempts.
  const body = JSON.stringify({
    from: SETTLEMENT_EMAIL_FROM, to: [input.recipient], subject: input.subject, text: input.text,
    attachments: [{ content: input.pdf.toString("base64"), filename: input.filename }],
  });
  await options.beforeSend?.();
  const response = await providerRequest(fetcher, "https://api.resend.com/emails", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": `ally-settlement/${input.attemptId}` }, body,
  }, "Envío de correo", true);
  if (typeof response.id !== "string" || !UUID.test(response.id)) {
    throw new DeliveryProviderError("Envío de correo: falta un recibo válido de Resend; requiere conciliación.", true);
  }
  return { providerId: response.id };
}

async function sendWhatsApp(input: SettlementDeliveryInput, options: Options, env: NodeJS.ProcessEnv, fetcher: typeof fetch) {
  const token = required(env, "WHATSAPP_ACCESS_TOKEN");
  const phoneId = required(env, "WHATSAPP_PHONE_NUMBER_ID", NUMERIC_ID);
  const businessId = required(env, "WHATSAPP_BUSINESS_ACCOUNT_ID", NUMERIC_ID);
  const version = env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v25.0";
  if (!/^v\d{1,3}\.\d{1,2}$/.test(version)) throw new DeliveryProviderError("WHATSAPP_GRAPH_API_VERSION no es válida.");
  const templateName = required(env, "WHATSAPP_SETTLEMENT_TEMPLATE_NAME", /^[a-z0-9_]{1,512}$/);
  const language = required(env, "WHATSAPP_SETTLEMENT_TEMPLATE_LANGUAGE", /^[a-z]{2}(?:_[A-Z]{2})?$/);
  const base = `https://graph.facebook.com/${version}`;
  const headers = { Authorization: `Bearer ${token}` };
  const phone = await providerRequest(fetcher, `${base}/${phoneId}?fields=id,display_phone_number`, { headers }, "Verificación del número de WhatsApp");
  if (phone.id !== phoneId || normalizeWhatsAppRecipient(phone.display_phone_number) !== SETTLEMENT_WHATSAPP_SENDER) {
    throw new DeliveryProviderError("WHATSAPP_PHONE_NUMBER_ID debe corresponder al número oficial +57 3124085562.");
  }
  // A template name is scoped to a WABA. Prove the checked template catalogue
  // owns this sender; a similarly named template in another WABA is not evidence.
  let ownsPhone = false;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ fields: "id,display_phone_number", limit: "100" });
    if (cursor) params.set("after", cursor);
    const numbers = await providerRequest(fetcher, `${base}/${businessId}/phone_numbers?${params}`, { headers }, "Verificación de la cuenta de WhatsApp");
    const ownedPhone = (Array.isArray(numbers.data) ? numbers.data : []).map(asRecord).find(number => number.id === phoneId);
    if (ownedPhone) {
      ownsPhone = normalizeWhatsAppRecipient(ownedPhone.display_phone_number) === SETTLEMENT_WHATSAPP_SENDER;
      break;
    }
    const paging = asRecord(numbers.paging);
    if (typeof paging.next !== "string" || !paging.next) break;
    const nextCursor = asRecord(paging.cursors).after;
    if (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2048 ||
      CONTROL_CHARACTERS.test(nextCursor) || seenCursors.has(nextCursor)) break;
    // Never follow provider-supplied next URLs with the access token. Only an
    // escaped cursor can be appended to the fixed Graph API endpoint above.
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (!ownsPhone) {
    throw new DeliveryProviderError("WHATSAPP_BUSINESS_ACCOUNT_ID debe contener el número oficial configurado +57 3124085562.");
  }
  const query = new URLSearchParams({ name: templateName, fields: "name,status,language,components,parameter_format", limit: "100" });
  const catalogue = await providerRequest(fetcher, `${base}/${businessId}/message_templates?${query}`, { headers }, "Verificación de plantilla de WhatsApp");
  const template = (Array.isArray(catalogue.data) ? catalogue.data : []).map(asRecord)
    .find(item => item.name === templateName && item.language === language);
  const components = (Array.isArray(template?.components) ? template.components : []).map(asRecord);
  const header = components.find(component => component.type === "HEADER");
  const bodyComponent = components.find(component => component.type === "BODY");
  if (template?.status !== "APPROVED" || (template.parameter_format && template.parameter_format !== "POSITIONAL") ||
    components.length !== 2 || header?.format !== "DOCUMENT" ||
    normalizeTemplateText(bodyComponent?.text) !== SETTLEMENT_WHATSAPP_TEMPLATE_BODY) {
    throw new DeliveryProviderError("La plantilla de WhatsApp debe estar APPROVED, tener encabezado DOCUMENT y el texto de liquidación de cuatro variables documentado.");
  }
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", "application/pdf");
  form.set("file", new Blob([new Uint8Array(input.pdf)], { type: "application/pdf" }), input.filename);
  const media = await providerRequest(fetcher, `${base}/${phoneId}/media`, { method: "POST", headers, body: form }, "Carga del PDF en WhatsApp");
  if (typeof media.id !== "string" || !NUMERIC_ID.test(media.id)) {
    throw new DeliveryProviderError("Carga del PDF en WhatsApp: falta un identificador de documento válido.");
  }
  const body = JSON.stringify({
    messaging_product: "whatsapp", recipient_type: "individual", to: normalizeWhatsAppRecipient(input.recipient),
    type: "template", biz_opaque_callback_data: input.attemptId,
    template: {
      name: templateName, language: { code: language }, components: [
        { type: "header", parameters: [{ type: "document", document: { id: media.id, filename: input.filename } }] },
        { type: "body", parameters: [input.allyName, input.periodStart, input.periodEnd, input.netAmount].map(text => ({ type: "text", text })) },
      ],
    },
  });
  await options.beforeSend?.();
  const response = await providerRequest(fetcher, `${base}/${phoneId}/messages`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body,
  }, "Envío de WhatsApp", true);
  const messages = Array.isArray(response.messages) ? response.messages : [];
  const providerId = messages.length === 1 ? asRecord(messages[0]).id : undefined;
  if (typeof providerId !== "string" || !/^wamid\.[A-Za-z0-9_+=/-]{1,490}$/.test(providerId)) {
    throw new DeliveryProviderError("Envío de WhatsApp: falta un recibo válido de Meta; requiere conciliación.", true);
  }
  return { providerId };
}

export async function sendSettlementDelivery(input: SettlementDeliveryInput, options: Options = {}): Promise<{ providerId: string }> {
  const env = options.env ?? process.env;
  if (env.ALLY_SETTLEMENT_DELIVERY_ENABLED !== "true") {
    throw new DeliveryProviderError("Falta habilitar ALLY_SETTLEMENT_DELIVERY_ENABLED=true después de verificar las integraciones.");
  }
  validateInput(input);
  const fetcher = options.fetch ?? fetch;
  return input.channel === "EMAIL" ? sendEmail(input, options, env, fetcher) : sendWhatsApp(input, options, env, fetcher);
}
