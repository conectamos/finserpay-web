import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root,
  "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { dianaRequestExtensionsActivatedAt, dianaRequestExtensionsEnabled } = await jiti.import("../lib/diana-extension-request-runtime.ts");
const { dianaExtensionsEnabled } = await jiti.import("../lib/diana-extension-runtime.ts");
const env = {
  DIANA_REQUEST_EXTENSIONS_ENABLED: "true", DIANA_REQUEST_EXTENSIONS_ACTIVATED_AT: "2026-11-02T19:00:00.000Z",
  DAPTA_ATTENTION_EVENTS_ENABLED: "true", DAPTA_ATTENTION_EVENT_TOKEN: "local-only-event-token-never-a-real-credential",
  DAPTA_MCP_API_KEY: "local-only-mcp-key", DAPTA_ATTENTION_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
  DAPTA_ATTENTION_AGENT_ID: "00000000-0000-4000-8000-000000000002",
  DAPTA_ATTENTION_AGENT_CHANNEL_ID: "00000000-0000-4000-8000-000000000003",
  WHATSAPP_ATTENTION_PHONE_NUMBER_ID: "1162059967000416", WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: "2148284059050848",
};

test("direct requests require their independent flag, replay floor and working native scope", () => {
  assert.equal(dianaRequestExtensionsEnabled({}), false);
  assert.equal(dianaRequestExtensionsEnabled(env), true);
  assert.equal(dianaExtensionsEnabled(env), false, "the old proposal feature is independent");
  assert.equal(dianaExtensionsEnabled({ ...env, DIANA_EXTENSIONS_ENABLED: "true" }), true);
  for (const patch of [
    { DIANA_REQUEST_EXTENSIONS_ENABLED: undefined }, { DIANA_REQUEST_EXTENSIONS_ENABLED: "false" },
    { DIANA_REQUEST_EXTENSIONS_ACTIVATED_AT: undefined }, { DAPTA_ATTENTION_EVENTS_ENABLED: "false" },
    { DAPTA_ATTENTION_EVENT_TOKEN: "short" }, { DAPTA_MCP_API_KEY: "" },
    { DAPTA_ATTENTION_AGENT_ID: "invalid" }, { DAPTA_ATTENTION_AGENT_CHANNEL_ID: "invalid" },
    { WHATSAPP_ATTENTION_PHONE_NUMBER_ID: "1162059967000417" }, { WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: "other" },
  ]) assert.equal(dianaRequestExtensionsEnabled({ ...env, ...patch }), false, JSON.stringify(Object.keys(patch)));
});

test("the replay floor is an explicit UTC instant, never a local or rollover date", () => {
  for (const value of ["2026-11-02T19:00:00Z", "2026-11-02T19:00:00.1Z", "2026-11-02T19:00:00.123Z"]) {
    assert.equal(dianaRequestExtensionsActivatedAt({ DIANA_REQUEST_EXTENSIONS_ACTIVATED_AT: value })?.getTime(), Date.parse(value));
  }
  for (const value of ["", "2026-11-02", "2026-11-02T19:00:00", "2026-11-02T14:00:00-05:00",
    "2026-02-30T19:00:00Z", "2026-13-02T19:00:00Z", "2026-11-02T24:00:00Z", "2026-11-02T19:00:00.1234Z"]) {
    assert.equal(dianaRequestExtensionsActivatedAt({ DIANA_REQUEST_EXTENSIONS_ACTIVATED_AT: value }), null, value);
  }
});
