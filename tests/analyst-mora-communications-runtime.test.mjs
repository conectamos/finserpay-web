import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
const jiti = createJiti(import.meta.url);
const policy = await jiti.import("../lib/collection-voice-policy.ts");
const key = "00000000-0000-4000-8000-000000000081";
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-10-13T17:30:00Z"])); }
  static now() { return +new Date("2026-10-13T17:30:00Z"); }
}
function fixture(options = {}) {
  const sends = [], selected = [], attempts = [];
  let extension = options.extension === true, phone = "573009999999";
  const db = {
    $executeRawUnsafe: async (sql, ...values) => {
      if (sql.includes('SET "status"=$2')) attempts.find(item => item.id === values[0]).status = values[1];
      if (sql.includes('SET "status"=\'SKIPPED\'')) attempts.find(item => item.id === values[0]).status = "SKIPPED";
      return 1;
    },
    $queryRawUnsafe: async (sql, ...values) => {
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("COALESCE(bool_or")) return [{ blocked: false, today: 0, total: 1 }];
      if (sql.includes("SELECT count(*)::int n")) return [{ n: 0 }];
      if (sql.includes('SELECT * FROM "CollectionVoiceAttempt"')) return attempts.filter(item => item.id === values[0]);
      if (sql.includes('SET "status"=\'DIALING\'')) { attempts.find(item => item.id === values[0]).status = "DIALING"; return [{ id: values[0] }]; }
      if (sql.includes('INSERT INTO "CollectionVoiceAttempt"')) {
        attempts.push({ id: values[0], creditoId: values[1], phone: values[3], status: "DISPATCHING", manualRequested: values[7], createdAt: new FixedDate(), optOut: false });
        return [{ id: values[0] }];
      }
      assert.fail("Unexpected SQL: " + sql);
    },
    $transaction: work => work(db),
  };
  const env = { DAPTA_COBRANZA_ENABLED: "true", DAPTA_COBRANZA_LIVE_READY: "true", DAPTA_COBRANZA_REFERENCES_OWNED: "true",
    DAPTA_COBRANZA_CALL_WEBHOOK_URL: "https://api.dapta.ai/api/synthetic-call-only", FINSERPAY_COBRANZA_API_TOKEN: "synthetic-selected-call-secret-32-chars",
    FINSERPAY_COBRANZA_AGENT_ID: "synthetic-agent", FINSERPAY_COBRANZA_ACTOR_ID: "51" };
  const modules = {
    "@/lib/prisma": { default: db },
    "@/lib/analyst-mora-management": {
      getMoraManagement: async id => {
        selected.push(id);
        return { credit: { id, enMora: options.paidBeforeSend && selected.length > 1 ? false : true,
          clienteDocumento: "100009999", clienteTelefono: phone, clienteNombre: "Cliente sintético", referenciaFamiliar1Telefono: "573008888888", prorrogaActiva: (extension || (options.extensionBeforeSend && selected.length > 1)) ? { id: "new-extension" } : null }, history: [] };
      },
      listMoraPortfolio: async () => options.automatic ? {items:[{id:9999}],hasMore:false} : assert.fail("Selected-credit dispatch must never scan the portfolio"),
      parseMoraManagement: input => input, createMoraManagement: async () => assert.fail("Dispatch is not a contact result"),
      createCreditManagement: async () => assert.fail("Dispatch is not a contact result"),
    },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/credit-welcome-voice-core": { matchWelcomeVoiceIdentity: () => false },
    "@/lib/credit-welcome-voice-document": { parseWelcomeVoiceSpokenDocument: () => null },
    "@/lib/dapta-welcome": { normalizeColombianMobile: value => value },
    "@/lib/dapta-collections-http": { collectionCallKey: () => key },
    "@/lib/collection-voice-policy": policy,
  };
  const service = loadReissueModule("lib/collection-voice-runtime.ts", modules, {
    Date: FixedDate, URLSearchParams, AbortSignal, process: { env },
    fetch: async (url, init) => { sends.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, call_id: "synthetic-call-9999" })); },
  });
  return { ...service, sends, selected, attempts, setExtension: value => { extension = value; }, setPhone: value => { phone = value; },
    authorize: () => service.collectionVoiceOperation(new Request("https://example.test/voice", { method: "POST", headers: { authorization: "Bearer " + env.FINSERPAY_COBRANZA_API_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ action: "authorize", event_token: policy.collectionSessionToken(key, env.FINSERPAY_COBRANZA_API_TOKEN) }) })) };
}
test("selected call targets an arbitrary credit beyond page 100 without scanning or rotating references", async () => {
  const f = fixture(); let verified = 0;
  const result = await f.runCollectionVoice({ immediate: true, limit: 1, creditId: 9999, requestId: key, beforeDispatch: async () => { verified++; } });
  assert.equal(result.accepted, 1); assert.equal(verified, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].body.credito_id, "9999"); assert.equal(f.sends[0].body.to_number, "+573009999999");
  assert.ok(f.selected.length >= 2); assert.ok(f.selected.every(id => id === 9999));
  assert.equal(f.attempts[0].id, key); assert.equal(f.attempts[0].manualRequested, true);
});
test("selected call revalidates nominal permission before provider and never records contact prematurely", async () => {
  const f = fixture();
  await assert.rejects(f.runCollectionVoice({ immediate: true, limit: 1, creditId: 9999, requestId: key, beforeDispatch: async () => { throw new Error("role revoked"); } }), /role revoked/);
  assert.equal(f.sends.length, 0); assert.equal(f.attempts[0].status, "SKIPPED");
});
test("payment between selecting and dispatching suppresses the outbound call", async () => {
  const f = fixture({ paidBeforeSend: true });
  const result = await f.runCollectionVoice({ immediate: true, limit: 1, creditId: 9999, requestId: key });
  assert.equal(result.accepted, 0); assert.equal(f.sends.length, 0); assert.equal(f.attempts[0].status, "SKIPPED");
});
test("provider authorization rechecks a newly approved extension and the current holder phone", async () => {
  const f = fixture();
  await f.runCollectionVoice({ immediate: true, limit: 1, creditId: 9999, requestId: key });
  f.attempts[0].status = "DISPATCHING"; f.setExtension(true);
  assert.equal((await (await f.authorize()).json()).allowed, false);
  f.setExtension(false); f.setPhone("573001111111");
  assert.equal((await (await f.authorize()).json()).allowed, false);
  f.setPhone("573009999999");
  assert.equal((await (await f.authorize()).json()).allowed, true);
  assert.equal(f.sends.length, 1, "provider authorization never dispatches another call");
});

test("automatic collection excludes active extensions before claiming an attempt",async()=>{
  const f=fixture({automatic:true,extension:true});
  const result=await f.runCollectionVoice({limit:1});
  assert.equal(result.eligible,0);assert.equal(f.attempts.length,0);assert.equal(f.sends.length,0);
});

test("automatic collection rechecks extensions immediately before the provider request",async()=>{
  const f=fixture({automatic:true,extensionBeforeSend:true});
  const result=await f.runCollectionVoice({limit:1});
  assert.equal(result.accepted,0);assert.equal(f.sends.length,0);assert.equal(f.attempts[0].status,'SKIPPED');
});

test("automatic call already dispatched cannot authorize collection after a new extension",async()=>{
  const f=fixture({automatic:true});
  await f.runCollectionVoice({limit:1});
  assert.equal(f.sends.length,1);assert.equal(f.attempts[0].manualRequested,false);
  f.attempts[0].id=key;f.attempts[0].status='DISPATCHING';f.setExtension(true);
  assert.equal((await(await f.authorize()).json()).allowed,false);
});