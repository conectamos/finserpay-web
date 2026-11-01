import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createMetaAttentionAdapter, META_ATTENTION_LINE, META_ATTENTION_MAX_WEBHOOK_BYTES } = await jiti.import("../lib/atencion-meta.ts");
const { readAttentionBody } = await jiti.import("../lib/atencion-meta-http.ts");
const { attentionJson, attentionHttpError } = await jiti.import("../lib/atencion-http.ts");
const secret = "test-only-bsuid-webhook-secret";
const now = Date.parse("2026-11-01T18:00:00Z");
const userId = "CO.DOCUMENTATION123";
const username = "perfil.de.prueba";
const source = readFileSync(new URL("../app/api/integraciones/atencion/whatsapp/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const ingested = [], warnings = [], loaded = { exports: {} };
  const adapter = createMetaAttentionAdapter({ env: {
    WHATSAPP_ATTENTION_PHONE_NUMBER_ID: META_ATTENTION_LINE.phoneNumberId,
    WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: META_ATTENTION_LINE.wabaId,
    WHATSAPP_ATTENTION_APP_SECRET: secret,
  }, now: () => now, fetch: async () => { assert.fail("el webhook no necesita llamadas al proveedor"); } });
  const dependencies = {
    "@/lib/atencion-meta": { createMetaAttentionAdapter: () => adapter, META_ATTENTION_MAX_WEBHOOK_BYTES },
    "@/lib/atencion-http": { attentionJson, attentionHttpError },
    "@/lib/atencion-meta-http": { readAttentionBody },
    "@/lib/atencion-meta-service": { attentionMetaRuntime: async () => ({ store: { ingest: async events => { ingested.push(events); } } }) },
  };
  runInNewContext(code, { module: loaded, exports: loaded.exports, Response, console: { warn: (...args) => warnings.push(args.join(" ")) },
    require: name => { assert.ok(name in dependencies, `Dependencia inesperada ${name}`); return dependencies[name]; } });
  async function post(value, signature) {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: META_ATTENTION_LINE.wabaId, changes: [{ field: "messages", ...value.change, value: { messaging_product: "whatsapp", metadata: { phone_number_id: META_ATTENTION_LINE.phoneNumberId }, ...value.data } }] }] });
    return loaded.exports.POST(new Request("https://finserpay.example.invalid/api/integraciones/atencion/whatsapp", { method: "POST", headers: {
      "content-type": "application/json", "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    }, body }));
  }
  return { post, ingested, warnings };
}
const profile = { contacts: [{ user_id: userId, profile: { name: "Perfil artificial", username } }] };
const message = { id: "wamid.BSUID_HTTP_TEST", timestamp: String(now / 1000 - 30), type: "text", text: { body: "Mensaje artificial de prueba" } };

test("el POST firmado ingresa el mensaje BSUID sin from ni wa_id en lugar de descartarlo con 200", async () => {
  const f = fixture(), response = await f.post({ data: { ...profile, messages: [{ ...message, from_user_id: userId }] } });
  assert.equal(response.status, 200); assert.equal(f.ingested.length, 1);
  assert.equal(f.ingested[0].messages.length, 1); assert.equal(f.ingested[0].messages[0].from, userId);
  assert.equal(f.ingested[0].messages[0].phone, null); assert.equal(f.ingested[0].messages[0].username, username);
  assert.equal(f.warnings.length, 0);
});
test("el POST también ingresa ecos del celular y estados con identidad BSUID", async () => {
  const f = fixture();
  assert.equal((await f.post({ change: { field: "smb_message_echoes" }, data: { ...profile,
    message_echoes: [{ ...message, from: META_ATTENTION_LINE.displayPhone.slice(1), to_user_id: userId }] } })).status, 200);
  assert.equal(f.ingested[0].echoes[0].to, userId); assert.equal(f.ingested[0].echoes[0].phone, null);
  assert.equal((await f.post({ data: { statuses: [{ id: message.id, recipient_user_id: userId, timestamp: message.timestamp, status: "delivered" }] } })).status, 200);
  assert.equal(f.ingested[1].statuses[0].recipient, userId);
});
test("un descarte deja solo contadores y jamás registra identidad, usuario, contenido ni firma", async () => {
  const f = fixture(), response = await f.post({ data: { ...profile, messages: [{ ...message, from_user_id: "@no_es_un_destinatario" }] } });
  assert.equal(response.status, 200); assert.equal(f.ingested.length, 0); assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /attention-meta-webhook-discarded/); assert.match(f.warnings[0], /"ignored":1/);
  for (const privateValue of [userId, username, message.text.body, secret, "no_es_un_destinatario", "sha256="]) assert.equal(f.warnings[0].includes(privateValue), false);
});
test("una firma no válida no ingresa mensajes ni registra los datos del evento", async () => {
  const f = fixture(), response = await f.post({ data: { ...profile, messages: [{ ...message, from_user_id: userId }] } }, `sha256=${"0".repeat(64)}`);
  assert.equal(response.status, 401); assert.equal(f.ingested.length, 0); assert.equal(f.warnings.length, 0);
});
