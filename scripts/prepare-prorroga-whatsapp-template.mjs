import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { PRORROGA_ACTIVADA_TEMPLATE_BODY, META_AUTOMATION_SCOPE, META_AUTOMATION_TEMPLATES } =
  await jiti.import("../lib/whatsapp-automation-meta-config.ts");
const name = "prorroga_activada";
const language = META_AUTOMATION_TEMPLATES[name].language;
const statuses = new Set(["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL", "PENDING_DELETION", "DELETED", "LIMIT_EXCEEDED", "ARCHIVED"]);
const numericId = value => typeof value === "string" && /^\d{5,30}$/.test(value);
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export class ProrrogaTemplateError extends Error {
  constructor(code) { super(code); this.name = "ProrrogaTemplateError"; this.code = code; }
}

/** Reads by default. The only optional write creates the absent template;
 * it never edits templates, sends messages, or changes channel configuration. */
export async function ensureProrrogaWhatsAppTemplate({ env = process.env, fetcher = fetch, apply = false, timeoutMs = 10000 } = {}) {
  try {
    const token = env.WHATSAPP_ATTENTION_ACCESS_TOKEN?.trim();
    if (!token) throw new ProrrogaTemplateError("MISSING_ATTENTION_ACCESS_TOKEN");
    if ((env.WHATSAPP_GRAPH_API_VERSION || "v25.0") !== "v25.0") throw new ProrrogaTemplateError("UNSUPPORTED_GRAPH_VERSION");
    if ((env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID && env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID !== META_AUTOMATION_SCOPE.wabaId)
      || (env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID && env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID !== META_AUTOMATION_SCOPE.phoneNumberId)) {
      throw new ProrrogaTemplateError("META_SCOPE_MISMATCH");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000 || typeof apply !== "boolean") {
      throw new ProrrogaTemplateError("INVALID_TEMPLATE_SETUP_OPTIONS");
    }
    const deadline = Date.now() + timeoutMs;
    const endpoint = `https://graph.facebook.com/v25.0/${META_AUTOMATION_SCOPE.wabaId}/message_templates`;
    async function graph(method, payload) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ProrrogaTemplateError("META_TEMPLATE_TIMEOUT");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const url = new URL(endpoint);
        if (method === "GET") {
          url.searchParams.set("name", name);
          url.searchParams.set("fields", "id,name,status,language,category,parameter_format,components");
          url.searchParams.set("limit", "100");
        }
        const response = await fetcher(url, {
          method, signal: controller.signal, cache: "no-store", redirect: "error",
          headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        if (!response.ok) throw new ProrrogaTemplateError(`META_TEMPLATE_HTTP_${response.status}`);
        if (Number(response.headers.get("content-length") || 0) > 65536) throw new ProrrogaTemplateError("META_TEMPLATE_RESPONSE_TOO_LARGE");
        const reader = response.body?.getReader();
        if (!reader) throw new ProrrogaTemplateError("META_TEMPLATE_INVALID_RESPONSE");
        const chunks = []; let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            length += chunk.value.length;
            if (length > 65536) { await reader.cancel(); throw new ProrrogaTemplateError("META_TEMPLATE_RESPONSE_TOO_LARGE"); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new ProrrogaTemplateError("META_TEMPLATE_INVALID_RESPONSE"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.error) throw new ProrrogaTemplateError("META_TEMPLATE_INVALID_RESPONSE");
        return parsed;
      } catch (error) {
        if (error instanceof ProrrogaTemplateError) throw error;
        throw new ProrrogaTemplateError(controller.signal.aborted ? "META_TEMPLATE_TIMEOUT" : "META_TEMPLATE_REQUEST_FAILED");
      } finally { clearTimeout(timer); controller.abort(); }
    }
    const listed = await graph("GET");
    if (!Array.isArray(listed.data)) throw new ProrrogaTemplateError("META_TEMPLATE_INVALID_RESPONSE");
    // An incomplete list must never be interpreted as permission to create.
    if (record(listed.paging).next) throw new ProrrogaTemplateError("META_TEMPLATE_LIST_INCOMPLETE");
    const matching = listed.data.map(record).filter(row => row.name === name);
    const summary = { templateName: name, language, category: "UTILITY", wabaId: META_AUTOMATION_SCOPE.wabaId };
    if (matching.length) {
      if (matching.length !== 1) throw new ProrrogaTemplateError("META_TEMPLATE_AMBIGUOUS");
      const row = matching[0];
      if (!numericId(row.id) || row.language !== language || row.category !== "UTILITY" || row.parameter_format !== "POSITIONAL"
        || !Array.isArray(row.components) || row.components.length !== 1 || row.components[0]?.type !== "BODY"
        || row.components[0].text !== PRORROGA_ACTIVADA_TEMPLATE_BODY) throw new ProrrogaTemplateError("META_TEMPLATE_CONTENT_MISMATCH");
      if (!statuses.has(row.status)) throw new ProrrogaTemplateError("META_TEMPLATE_INVALID_RESPONSE");
      return { ...summary, exists: true, created: false, status: row.status, approved: row.status === "APPROVED", id: row.id };
    }
    if (!apply) return { ...summary, exists: false, created: false, status: "MISSING", approved: false };
    const created = await graph("POST", {
      name, language, category: "UTILITY", parameter_format: "POSITIONAL", allow_category_change: false,
      components: [{ type: "BODY", text: PRORROGA_ACTIVADA_TEMPLATE_BODY, example: { body_text: [["Ana Ejemplo", "3"]] } }],
    });
    if (!numericId(created.id) || created.category !== "UTILITY" || !statuses.has(created.status)) throw new ProrrogaTemplateError("META_TEMPLATE_INVALID_CREATE_RECEIPT");
    return { ...summary, exists: true, created: true, status: created.status, approved: created.status === "APPROVED", id: created.id };
  } catch (error) {
    if (error instanceof ProrrogaTemplateError) throw error;
    throw new ProrrogaTemplateError("META_TEMPLATE_SETUP_FAILED");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--apply") || args.length > 1) throw new ProrrogaTemplateError("INVALID_TEMPLATE_SETUP_ARGUMENTS");
    const result = await ensureProrrogaWhatsAppTemplate({ apply: args.includes("--apply") });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    if (!result.approved) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof ProrrogaTemplateError ? error.code : "META_TEMPLATE_SETUP_FAILED" }));
    process.exitCode = 1;
  }
}
