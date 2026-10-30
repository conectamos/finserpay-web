import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const origin = "https://finser.example";
const id = randomUUID();
const actor = { userId: 1, sellerId: null, central: true, admin: true, key: "user:1", name: "Test", sedeId: 1, aliadoId: 1, supervisor: false };
const inbox = { schemaReady: true, branches: [{ id: 1, name: "Test" }], conversations: [] };
const integration = { configured: false, canSync: false, canSend: false, canHandoff: false, status: "not_configured", message: "Pendiente" };
function compile(file, mocks) {
  const compiled = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    assert.ok(name in mocks, `No live dependency allowed: ${name}`); return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}
const core = compile("lib/atencion-core.ts", {});
class AttentionDaptaError extends Error { constructor(message, status) { super(message); this.status = status; } }
class AttentionMetaError extends Error { constructor(code, message, status = 502, uncertain = false) { super(message); this.code = code; this.status = status; this.uncertain = uncertain; } }
function harness(file = "app/api/atencion/route.ts", options = {}) {
  const calls = { access: 0, inbox: [], create: [], detail: [], mutate: [], quick: [], fetch: [], import: [], readIntegration: [], readDetail: [] };
  const access = { ...core, getAttentionAccess: async () => {
    calls.access++; if (options.accessError) throw options.accessError; return options.actor || actor;
  } };
  const provider = { AttentionDaptaError, attentionIntegrationStatus: () => integration,
    fetchDaptaConversationSnapshots: async input => { calls.fetch.push(input); if (options.providerError) throw options.providerError; return { snapshots: [], nextCursor: "opaque", skipped: 0 }; } };
  const storage = {
    getAttentionHistoryCursors: async () => ({}),
    getAttentionInbox: async (...args) => { calls.inbox.push(args); if (options.storeError) throw options.storeError; return options.inbox || inbox; },
    createAttentionCase: async (...args) => { calls.create.push(args); return { id }; },
    getAttentionDetail: async (...args) => { calls.detail.push(args); if (options.storeError) throw options.storeError; return { conversation: { id }, messages: [] }; },
    mutateAttentionConversation: async (...args) => { calls.mutate.push(args); if (options.storeError) throw options.storeError; },
    saveAttentionQuickReply: async (...args) => { calls.quick.push(args); },
    importAttentionSnapshots: async (...args) => { calls.import.push(args); return { imported: 0 }; },
  };
  const http = compile("lib/atencion-http.ts", { "./atencion-core": core, "./atencion-dapta": provider, "./atencion-meta": { AttentionMetaError } });
  const readModel={attentionReadIntegration:async ready=>{calls.readIntegration.push(ready);return options.integration||integration;},
    attentionReadDetail:async(actor,detail)=>{calls.readDetail.push([actor,detail]);if(options.messagingError)throw options.messagingError;return {...detail,...options.detailEnrichment};}};
  const route = compile(file, { "@/lib/atencion-core": access, "@/lib/atencion-storage": storage, "@/lib/atencion-dapta": provider, "@/lib/atencion-http": http, "@/lib/atencion-read-model":readModel });
  return { ...route, ...http, calls };
}
function request(body = {}, method = "POST", headers = {}, url = `${origin}/api/atencion`) {
  const merged = new Headers({ origin, "content-type": "application/json", ...headers });
  for (const [key, value] of Object.entries(headers)) if (value === null) merged.delete(key);
  return new Request(url, { method, headers: merged, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const context = { params: Promise.resolve({ id }) };
function privateResponse(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("every attention handler requires authentication before data access", async () => {
  for (const [file, method] of [["route.ts", "GET"], ["route.ts", "POST"], ["[id]/route.ts", "GET"], ["[id]/route.ts", "PATCH"], ["sync/route.ts", "POST"], ["quick-replies/route.ts", "POST"]]) {
    const h = harness(`app/api/atencion/${file}`, { accessError: new core.AttentionError("Inicia sesión", 401) });
    const response = await h[method](method === "GET" ? new Request(`${origin}/api/atencion`) : request({}, method), context);
    assert.equal(response.status, 401); privateResponse(response);
    for (const key of ["inbox", "create", "detail", "mutate", "quick", "fetch", "import", "readIntegration", "readDetail"]) assert.equal(h.calls[key].length, 0);
  }
});

test("CSRF blocks absent, malformed and cross-site Origin before session", async () => {
  for (const headers of [{ origin: null }, { origin: "null" }, { origin: "https://attacker.example" }, { origin: `${origin}/` }, { origin: "https://user@finser.example" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "http://finser.example" }]) {
    const h = harness(); const response = await h.POST(request({}, "POST", headers));
    assert.equal(response.status, 403, JSON.stringify(headers)); assert.equal(h.calls.access, 0); privateResponse(response);
  }
  const h = harness();
  const response = await h.POST(request({ phone: "3000000000", name: "Test fixture", sedeId: 1, requestId: randomUUID() }, "POST", { host: "finser.example", "x-forwarded-proto": "https" }, "http://internal:3000/api/atencion"));
  assert.equal(response.status, 201);
});

test("bounded JSON reader checks bytes independently from Content-Length", async () => {
  for (const body of ["[1]", "null", "17", "{", '"text"']) {
    const h = harness(); assert.equal((await h.POST(request(body))).status, 400); assert.equal(h.calls.create.length, 0);
  }
  const h = harness();
  assert.equal((await h.POST(request({ name: "é".repeat(8500) }, "POST", { "content-length": "1" }))).status, 413);
  assert.equal((await h.POST(request({}, "POST", { "content-type": "application/jsonp" }))).status, 415);
  assert.equal(h.calls.create.length, 0);
});

test("create internal case ignores actor spoofing and never calls provider", async () => {
  const h = harness(); const requestId = randomUUID();
  const response = await h.POST(request({ phone: "3000000000", name: "Test fixture", sedeId: 1, requestId, userId: 999, central: true, channel: "whatsapp", text: "do not send" }));
  assert.equal(response.status, 201);
  assert.deepEqual(h.calls.create, [[actor, { phone: "3000000000", name: "Test fixture", requestId }]]);
  assert.equal(h.calls.fetch.length, 0); privateResponse(response);
});

test("list validates filters and uses authenticated actor, detail validates UUID", async () => {
  const h = harness();
  assert.equal((await h.GET(new Request(`${origin}/api/atencion?filter=all&search=Test&page=2&central=true`))).status, 200);
  assert.deepEqual(h.calls.inbox[0], [actor, { filter: "all", search: "Test", page: 2 }]);
  for (const query of ["page=-1", "page=1.5", "filter=unknown"]) assert.equal((await h.GET(new Request(`${origin}/api/atencion?${query}`))).status, 400);
  const detail = harness("app/api/atencion/[id]/route.ts");
  assert.equal((await detail.GET(new Request(origin), { params: Promise.resolve({ id: "1' OR true" }) })).status, 400);
  assert.equal(detail.calls.detail.length, 0);
});

test("GET connects Meta capability to inbox/detail and rejects access lost during enrichment",async()=>{
  const connected={...integration,configured:true,canSend:true,status:"meta_ready",message:"Meta"};
  const list=harness(undefined,{integration:connected});
  const response=await list.GET(new Request(`${origin}/api/atencion`));assert.deepEqual((await response.json()).integration,connected);assert.deepEqual(list.calls.readIntegration,[true]);
  const messaging={windowExpiresAt:"2026-10-31T15:00:00Z",canReply:true,reason:null};
  const detail=harness("app/api/atencion/[id]/route.ts",{detailEnrichment:{messaging,permissions:{canSend:true}}});
  const result=await detail.GET(new Request(origin),context);assert.equal(result.status,200);assert.deepEqual((await result.json()).messaging,messaging);assert.equal(detail.calls.readDetail[0][0],actor);
  for(const status of [401,403,404]){
    const denied=harness("app/api/atencion/[id]/route.ts",{messagingError:new core.AttentionError("Acceso revocado",status)});
    const result=await denied.GET(new Request(origin),context);assert.equal(result.status,status);assert.equal((await result.json()).conversation,undefined);privateResponse(result);
  }
});

test("mutations validate actions, version, idempotency key and never accept send", async () => {
  const h = harness("app/api/atencion/[id]/route.ts"); const requestId = randomUUID();
  const body = { action: "note", text: "Internal fixture", version: 1, requestId, userId: 888 };
  assert.equal((await h.PATCH(request(body, "PATCH"), context)).status, 200);
  assert.deepEqual(h.calls.mutate[0], [actor, id, { action: "note", text: "Internal fixture", version: 1, requestId }]);
  for (const invalid of [{ action: "send" }, { version: 0 }, { requestId: "bad" }, { action: "transfer", assigneeKey: "seller:NaN" }, { action: "tags", tags: "x" }]) {
    assert.equal((await h.PATCH(request({ ...body, ...invalid }, "PATCH"), context)).status, 400);
  }
  assert.equal(h.calls.mutate.length, 1);
});

test("only central may approve replies or synchronize; provider is not called on missing schema/scope", async () => {
  for (const file of ["sync", "quick-replies"]) {
    const h = harness(`app/api/atencion/${file}/route.ts`, { actor: { ...actor, central: false } });
    assert.equal((await h.POST(request({ sedeId: 1 }))).status, 403);
    assert.equal(h.calls.fetch.length + h.calls.quick.length, 0);
  }
  for (const [customInbox, status] of [[{ ...inbox, schemaReady: false }, 503]]) {
    const h = harness("app/api/atencion/sync/route.ts", { inbox: customInbox });
    assert.equal((await h.POST(request({ sedeId: 1 }))).status, status); assert.equal(h.calls.fetch.length, 0);
  }
});

test("sync imports only confirmed provider data; failure never persists or leaks provider details", async () => {
  const h = harness("app/api/atencion/sync/route.ts");
  const response = await h.POST(request({ cursor: "previous" }));
  assert.equal(response.status, 200); assert.deepEqual(h.calls.fetch, [{ cursor: "previous", historyCursors: {} }]);
  assert.deepEqual(h.calls.import, [[actor, []]]);
  assert.deepEqual(await response.json(), { imported: 0, processed: 0, skipped: 0, nextCursor: "opaque" });
  const failed = harness("app/api/atencion/sync/route.ts", { providerError: new Error("secret token SQL phone private") });
  const error = await failed.POST(request({ sedeId: 1 }));
  assert.equal(error.status, 500); assert.doesNotMatch(JSON.stringify(await error.json()), /secret|token|SQL|phone|private/);
  assert.equal(failed.calls.import.length, 0); privateResponse(error);
});

test("version conflicts are explicit and no storage error is serialized", async () => {
  for (const [error, status] of [[new core.AttentionError("La conversación cambió. Actualiza.", 409), 409], [new Error("database URL secret password"), 500]]) {
    const h = harness("app/api/atencion/[id]/route.ts", { storeError: error });
    const response = await h.PATCH(request({ action: "close", version: 1, requestId: randomUUID() }, "PATCH"), context);
    assert.equal(response.status, status); assert.doesNotMatch(JSON.stringify(await response.json()), /database|secret|password/); privateResponse(response);
  }
});
