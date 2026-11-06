import { createHash } from "node:crypto";
import { AllyContactValidationError, normalizeAllyWhatsApp } from "./ally-contact";
import { CutCollectionError } from "./cut-collection-access";
import { buildCutCollectionPdf } from "./cut-collection-pdf";
import type { CutReport } from "./cut-collection-types";

export const RISK_WHATSAPP_TEMPLATE = "finser_informe_riesgo_temprano";
export const RISK_WHATSAPP_LANGUAGE = "es_CO";
export const RISK_WHATSAPP_BODY = "Hola. Adjuntamos el informe de riesgo temprano de tu comercio para el corte consultado en FINSER PAY.";

const uncertain = "WhatsApp no confirmó el envío. Verifica si llegó antes de volver a enviarlo.";
const numericId = /^\d{5,30}$/;

export class CutCollectionWhatsAppError extends Error {
  constructor(message: string, public readonly status: 409 | 502 | 503, public readonly retryWithNewKey = false) { super(message); }
}

function configuration() {
  const token = process.env.WHATSAPP_ATTENTION_ACCESS_TOKEN?.trim();
  const phone = process.env.WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID?.trim() || "";
  const business = process.env.WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID?.trim() || "";
  const version = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v25.0";
  if (!token || !numericId.test(phone) || !numericId.test(business) || !/^v\d{1,3}\.\d{1,2}$/.test(version)) {
    throw new CutCollectionWhatsAppError("La línea de WhatsApp para aliados no está configurada.", 503);
  }
  return { base: `https://graph.facebook.com/${version}`, phone, business, headers: { Authorization: `Bearer ${token}` } };
}

async function graph(url: string, options: RequestInit) {
  return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(12_000) });
}

async function prepareDocument(report: CutReport) {
  const { base, phone, business, headers } = configuration();
  const query = new URLSearchParams({ name: RISK_WHATSAPP_TEMPLATE, fields: "name,status,language,components", limit: "50" });
  const [sender, templates] = await Promise.all([
    graph(`${base}/${phone}?fields=display_phone_number`, { headers }),
    graph(`${base}/${business}/message_templates?${query}`, { headers }),
  ]);
  if (!sender.ok || !templates.ok) throw new CutCollectionWhatsAppError("No se pudo verificar la línea o la plantilla de WhatsApp.", 503);
  const phoneInfo = await sender.json();
  if (normalizeAllyWhatsApp(phoneInfo.display_phone_number) !== "573124085562") {
    throw new CutCollectionWhatsAppError("La línea configurada no corresponde al WhatsApp oficial de aliados.", 503);
  }
  type TemplateComponent = { type?: string; format?: string; text?: string };
  type Template = { name?: string; language?: string; status?: string; components?: TemplateComponent[] };
  const catalogue = await templates.json() as { data?: Template[] };
  const template = catalogue.data?.find(item => item.name === RISK_WHATSAPP_TEMPLATE && item.language === RISK_WHATSAPP_LANGUAGE);
  const components = template?.components ?? [];
  if (template?.status !== "APPROVED" || components.length !== 2 ||
      !components.some(item => item.type === "HEADER" && item.format === "DOCUMENT") ||
      !components.some(item => item.type === "BODY" && item.text === RISK_WHATSAPP_BODY)) {
    throw new CutCollectionWhatsAppError("Meta aún no tiene aprobada la plantilla de WhatsApp para este informe.", 503);
  }
  const pdf = await buildCutCollectionPdf(report);
  const filename = `FINSERPAY_Riesgo_${report.cutDate}.pdf`;
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", "application/pdf");
  form.set("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
  const upload = await graph(`${base}/${phone}/media`, { method: "POST", headers, body: form });
  const media = await upload.json().catch(() => null);
  if (!upload.ok || typeof media?.id !== "string" || !numericId.test(media.id)) {
    throw new CutCollectionWhatsAppError("WhatsApp no pudo preparar el PDF del informe.", 502);
  }
  return { url: `${base}/${phone}/messages`, headers, mediaId: media.id as string, filename };
}

export async function sendCutCollectionWhatsApp(input: { userId: number; key: string; allyId: number; report: CutReport }) {
  const { default: prisma } = await import("./prisma");
  const ally = await prisma.aliado.findUnique({ where: { id: input.allyId }, select: { activo: true, telefonoWhatsapp: true } });
  let recipient: string | null = null;
  try { if (ally?.activo) recipient = normalizeAllyWhatsApp(ally.telefonoWhatsapp); }
  catch (error) { if (!(error instanceof AllyContactValidationError)) throw error; }
  if (!recipient) throw new CutCollectionError("El aliado no tiene un número de WhatsApp válido registrado.", 422);
  const scope = createHash("sha256").update(JSON.stringify([input.report.filters, recipient])).digest("hex");
  const { userId, key } = input;
  async function existing() {
    const [attempt] = await prisma.$queryRaw<Array<{ scopeHash: string; state: string }>>`
      SELECT "scopeHash", "state" FROM "CutCollectionWhatsAppAttempt"
      WHERE "userId" = ${userId} AND "requestKey" = ${key}::uuid`;
    if (!attempt) return false;
    if (attempt.scopeHash !== scope) throw new CutCollectionWhatsAppError("La solicitud corresponde a otro informe.", 409);
    if (attempt.state === "ACCEPTED") return true;
    if (attempt.state === "REJECTED") throw new CutCollectionWhatsAppError("WhatsApp rechazó el envío del informe.", 502, true);
    throw new CutCollectionWhatsAppError(uncertain, 409);
  }
  if (await existing()) return recipient;

  let document: Awaited<ReturnType<typeof prepareDocument>>;
  try { document = await prepareDocument(input.report); }
  catch (error) {
    if (error instanceof CutCollectionWhatsAppError) throw error;
    throw new CutCollectionWhatsAppError("No se pudo preparar el informe en WhatsApp.", 503);
  }
  const claimed = await prisma.$executeRaw`
    INSERT INTO "CutCollectionWhatsAppAttempt" ("userId", "requestKey", "scopeHash", "state")
    VALUES (${userId}, ${key}::uuid, ${scope}, 'SENDING') ON CONFLICT DO NOTHING`;
  if (!claimed) {
    if (await existing()) return recipient;
    throw new CutCollectionWhatsAppError(uncertain, 409);
  }

  let response: Response;
  try {
    response = await graph(document.url, {
      method: "POST", headers: { ...document.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to: recipient, type: "template",
        template: { name: RISK_WHATSAPP_TEMPLATE, language: { code: RISK_WHATSAPP_LANGUAGE }, components: [
          { type: "header", parameters: [{ type: "document", document: { id: document.mediaId, filename: document.filename } }] },
        ] },
      }),
    });
  } catch { throw new CutCollectionWhatsAppError(uncertain, 503); }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 409) throw new CutCollectionWhatsAppError(uncertain, 503);
    await prisma.$executeRaw`UPDATE "CutCollectionWhatsAppAttempt" SET "state" = 'REJECTED'
      WHERE "userId" = ${userId} AND "requestKey" = ${key}::uuid`;
    throw new CutCollectionWhatsAppError("WhatsApp rechazó el envío del informe.", 502, true);
  }
  const accepted = await response.json().catch(() => null);
  const id = accepted?.messages?.[0]?.id;
  if (typeof id !== "string" || !/^wamid\.[A-Za-z0-9_+=/-]{1,490}$/.test(id)) {
    throw new CutCollectionWhatsAppError(uncertain, 503);
  }
  await prisma.$executeRaw`UPDATE "CutCollectionWhatsAppAttempt" SET "state" = 'ACCEPTED', "providerId" = ${id}
    WHERE "userId" = ${userId} AND "requestKey" = ${key}::uuid`;
  return recipient;
}
