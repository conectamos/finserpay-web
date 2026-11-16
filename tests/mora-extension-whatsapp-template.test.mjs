import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { ensureProrrogaWhatsAppTemplate } from "../scripts/prepare-prorroga-whatsapp-template.mjs";

const { PRORROGA_ACTIVADA_TEMPLATE_BODY, PRORROGA_ACTIVADA_V2_TEMPLATE_BODY, META_AUTOMATION_SCOPE } = await createJiti(import.meta.url, { fsCache: false }).import("../lib/whatsapp-automation-meta-config.ts");
const env = { WHATSAPP_ATTENTION_ACCESS_TOKEN: "fixture-secret-never-print", WHATSAPP_GRAPH_API_VERSION: "v25.0" };
const template = overrides => ({ id: "123456789012345", name: "prorroga_activada_v2", language: "es", category: "UTILITY", parameter_format: "POSITIONAL", status: "APPROVED",
  components: [{ type: "BODY", text: PRORROGA_ACTIVADA_V2_TEMPLATE_BODY }], ...overrides });
const response = value => Response.json(value);
function fixture({ rows = [], post, listed, fetchError } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(url.pathname, `/v25.0/${META_AUTOMATION_SCOPE.wabaId}/message_templates`);
    assert.equal(init.headers.Authorization, `Bearer ${env.WHATSAPP_ATTENTION_ACCESS_TOKEN}`);
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    if (fetchError) throw fetchError;
    return init.method === "GET" ? response(listed || { data: rows }) : post || response({ id: "987654321012345", status: "PENDING", category: "UTILITY" });
  };
  return { calls, run: options => ensureProrrogaWhatsAppTemplate({ env, fetcher, ...options }) };
}

test("importar el preparador no consulta Meta y el modo predeterminado solo lee", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  const result = await f.run();
  assert.equal(result.status, "MISSING"); assert.equal(result.created, false); assert.equal(result.approved, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].url.searchParams.get("name"), "prorroga_activada_v2");
  assert.match(f.calls[0].url.searchParams.get("fields"), /parameter_format/);
  assert.equal(f.calls[0].url.searchParams.has("access_token"), false);
});

test("plantilla aprobada exacta se valida sin modificarla incluso con --apply", async () => {
  const f = fixture({ rows: [template()] }), result = await f.run({ apply: true });
  assert.equal(result.approved, true); assert.equal(result.exists, true); assert.equal(result.created, false);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

for (const status of ["PENDING", "REJECTED", "PAUSED", "DISABLED"]) {
  test(`${status} informa estado real y no recrea ni modifica la plantilla`, async () => {
    const f = fixture({ rows: [template({ status })] }), result = await f.run({ apply: true });
    assert.equal(result.status, status); assert.equal(result.approved, false); assert.equal(result.created, false);
    assert.equal(f.calls.length, 1);
  });
}

test("--apply crea solo cuando no existe, conserva texto canónico y usa ejemplos ficticios", async () => {
  const f = fixture(), result = await f.run({ apply: true });
  assert.equal(result.created, true); assert.equal(result.status, "PENDING"); assert.equal(result.approved, false);
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "POST"]);
  const payload = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(payload, { name: "prorroga_activada_v2", language: "es", category: "UTILITY", parameter_format: "POSITIONAL", allow_category_change: false,
    components: [{ type: "BODY", text: PRORROGA_ACTIVADA_V2_TEMPLATE_BODY, example: { body_text: [["Ana Ejemplo", "4", "21/11/2026"]] } }] });
  assert.equal(f.calls.some(call => call.url.pathname.endsWith("/messages")), false);
});

for (const override of [
  { language: "es_CO" }, { category: "MARKETING" }, { parameter_format: "NAMED" },
  { components: [{ type: "BODY", text: PRORROGA_ACTIVADA_V2_TEMPLATE_BODY.replace("3 meses", "90 días") }] },
  { components: [{ type: "BODY", text: PRORROGA_ACTIVADA_V2_TEMPLATE_BODY }, { type: "FOOTER", text: "Otra nota" }] },
]) {
  test(`una plantilla existente distinta no se sobrescribe: ${Object.keys(override)[0]}`, async () => {
    const f = fixture({ rows: [template(override)] });
    await assert.rejects(f.run({ apply: true }), { code: "META_TEMPLATE_CONTENT_MISMATCH" });
    assert.equal(f.calls.length, 1);
  });
}

test("crear v2 conserva la plantilla v1 aprobada sin editarla ni reutilizar su nombre", async () => {
  const legacy = template({ name: "prorroga_activada", components: [{ type: "BODY", text: PRORROGA_ACTIVADA_TEMPLATE_BODY }] });
  const before = structuredClone(legacy), f = fixture({ rows: [legacy] });
  const result = await f.run({ apply: true });
  assert.equal(result.templateName, "prorroga_activada_v2"); assert.equal(result.created, true);
  assert.deepEqual(legacy, before);
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "POST"]);
  assert.equal(JSON.parse(f.calls[1].init.body).name, "prorroga_activada_v2");
  assert.equal(f.calls.some(call => call.url.pathname.endsWith(`/${legacy.id}`)), false);
});

test("v2 debe incluir la fecha como tercer parámetro y mantener completo el cuerpo anterior", async () => {
  assert.equal(PRORROGA_ACTIVADA_V2_TEMPLATE_BODY.replace("📅 *Fecha de vencimiento de la prórroga:* {{3}}\n\n", ""), PRORROGA_ACTIVADA_TEMPLATE_BODY);
  assert.equal(PRORROGA_ACTIVADA_TEMPLATE_BODY.includes("{{3}}"), false);
  const f = fixture({ rows: [template({ components: [{ type: "BODY", text: PRORROGA_ACTIVADA_TEMPLATE_BODY }] })] });
  await assert.rejects(f.run({ apply: true }), { code: "META_TEMPLATE_CONTENT_MISMATCH" });
  assert.equal(f.calls.length, 1);
});

test("resultados ambiguos o incompletos no autorizan una creación", async () => {
  for (const listed of [{ data: [template(), template()] }, { data: [], paging: { next: "https://host-ajeno.invalid?access_token=secret" } }, { data: null }]) {
    const f = fixture({ listed }); await assert.rejects(f.run({ apply: true }));
    assert.equal(f.calls.length, 1);
  }
});

test("token ausente, cuenta ajena, versión ajena y opciones inválidas se rechazan antes de red", async () => {
  for (const options of [
    { env: {} }, { env: { ...env, WHATSAPP_ACCESS_TOKEN: "otp-no-usar", WHATSAPP_ATTENTION_ACCESS_TOKEN: "" } },
    { env: { ...env, WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: "11111111111111" } },
    { env: { ...env, WHATSAPP_ATTENTION_PHONE_NUMBER_ID: "11111111111111" } },
    { env: { ...env, WHATSAPP_GRAPH_API_VERSION: "v99.0" } }, { timeoutMs: 25000 }, { apply: "true" },
  ]) {
    const f = fixture(); await assert.rejects(f.run(options)); assert.equal(f.calls.length, 0);
  }
});

test("fallos remotos se sanitizan y no reintentan ni exponen secretos", async () => {
  const f = fixture({ fetchError: new Error("Bearer fixture-secret-never-print https://host?access_token=secret") });
  await assert.rejects(f.run({ apply: true }), error => {
    assert.equal(error.code, "META_TEMPLATE_REQUEST_FAILED");
    assert.doesNotMatch(`${error.message} ${error.stack}`, /fixture-secret|access_token/); return true;
  });
  assert.equal(f.calls.length, 1);
  const rejected = fixture({ post: new Response("Bearer fixture-secret-never-print", { status: 403 }) });
  await assert.rejects(rejected.run({ apply: true }), { code: "META_TEMPLATE_HTTP_403" });
  assert.equal(rejected.calls.length, 2);
});

test("timeout aborta la consulta y no crea ni envía", async () => {
  let calls = 0;
  await assert.rejects(ensureProrrogaWhatsAppTemplate({ env, apply: true, timeoutMs: 10, fetcher: async (_url, init) => {
    calls++; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("fixture-secret")), { once: true }));
  } }), { code: "META_TEMPLATE_TIMEOUT" });
  assert.equal(calls, 1);
});

test("respuesta excesiva o recibo de creación incompleto no aparentan aprobación", async () => {
  await assert.rejects(ensureProrrogaWhatsAppTemplate({ env, fetcher: async () => new Response("x".repeat(65537)) }), { code: "META_TEMPLATE_RESPONSE_TOO_LARGE" });
  const f = fixture({ post: response({ status: "APPROVED", category: "UTILITY" }) });
  await assert.rejects(f.run({ apply: true }), { code: "META_TEMPLATE_INVALID_CREATE_RECEIPT" });
});
