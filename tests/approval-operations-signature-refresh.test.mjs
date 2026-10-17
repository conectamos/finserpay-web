import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import test from "node:test";
import ts from "typescript";

function load(path, dependencies = {}, loose = false) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, Buffer, Date, URL, Request, Response, TextDecoder, console,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return crypto;
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (loose && name.startsWith("@/")) return {};
      assert.fail(`Unexpected dependency in ${path}: ${name}`);
    },
  }, { filename: path });
  return loadedModule.exports;
}

const { ApprovalOperationalError } = load("lib/approval-operations-write.ts", {}, true);
const { CreditApprovalError } = load("lib/credit-approval-errors.ts");
const core = load("lib/approval-operations-core.ts");
const statuses = load("lib/firmaseguro-status.ts");
const reader = load("lib/approval-operations-read.ts", {
  "@/lib/approval-operations-core": core,
  "@/lib/firmaseguro-status": statuses,
}, true);
const actorAccess = load("lib/analyst-mora-access.ts", {
  "@/lib/credit-approval-errors": { CreditApprovalError },
}, true);
const processUuid = "10000000-0000-4000-8000-000000000001";
const actor = { id: 7, nombre: "Untrusted old name" };

function fixture(options = {}) {
  const calls = { provider: 0, lock: 0, released: 0, audits: [], role: 0, queries: [] };
  const state = { roleActive: true, available: true, duplicated: false,
    process: { id: 21, draftId: 31, creditoId: null, processUuid, status: "CREATED",
      lastError: "Transient download failure", signedDocumentBase64: null,
      completedAt: null, supersededAt: null, requestPayload: { secret: "must stay server-side" },
      statusPayload: { secret: "private provider payload" } }, ...options.state };
  if (options.kind === "CREDIT") state.process.creditoId = 50;
  function detail() {
    const status = reader.operationalSignatureState({ ...state.process,
      hasSignedDocument: Boolean(state.process.signedDocumentBase64?.startsWith("JVBERi0")) });
    return { kind: options.kind || "DRAFT", id: options.kind === "CREDIT" ? 50 : 31,
      signature: { processUuid: state.process.processUuid, status },
      capabilities: { canRedirectPendingSignature: status === "PENDING" } };
  }
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      calls.queries.push(sql);
      if (sql.includes('FROM "Usuario" u JOIN "Rol"')) {
        calls.role++;
        return state.roleActive ? [{ nombre: "Verified analyst", role: "ANALISTA_APROBACION" }] : [];
      }
      if (sql.includes('FROM "Credito"')) return state.available ? [{ id: 50 }] : [];
      if (sql.includes('FROM "CreditoBorrador"')) return state.available && params[0] === 31
        ? [{ id: 31, currentStep: 4 }] : [];
      if (sql.includes('FROM "FirmaSeguroProcess"')) return state.duplicated
        ? [{ ...state.process }, { ...state.process, id: 22 }] : [{ ...state.process }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...params) {
      assert.match(sql, /INSERT INTO "ApprovalOperationalAction"/);
      assert.match(sql, /'SIGNATURE_STATUS_CHECKED'/);
      assert.doesNotMatch(sql, /beforeContact|afterContact|UPDATE|DELETE/);
      calls.audits.push(params);
      return 1;
    },
  };
  const prisma = { ...db, $transaction: async callback => callback(db) };
  const backend = load("lib/approval-operational-signature-refresh.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/analyst-mora-access": actorAccess,
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
    "@/lib/approval-operations-read": { operationalCaseIdentity: reader.operationalCaseIdentity,
      getOperationalCase: async () => detail() },
    "@/lib/approval-operations-write": { ApprovalOperationalError },
    "@/lib/firmaseguro-status": statuses,
    "@/lib/firmaseguro-credit": { refreshFirmaSeguroProcess: async (process, refreshOptions) => {
      calls.provider++;
      assert.equal(process.processUuid, processUuid);
      assert.equal(refreshOptions.synchronizeContractState, false);
      if (options.providerError) throw new Error("private upstream error detail");
      state.process.status = options.providerStatus || "PENDING";
      state.process.lastError = null;
      if (options.providerStatus === "COMPLETED") state.process.completedAt = new Date();
      if (options.signedPdf) {
        state.process.status = "SIGNED";
        state.process.completedAt = new Date();
        state.process.signedDocumentBase64 = Buffer.from("%PDF-1.7\nsigned").toString("base64");
      }
      options.afterProvider?.(state);
      return state.process;
    } },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {},
      tryAcquireSolicitudOperationLock: async id => {
        assert.equal(id, 31); calls.lock++;
        return options.busy ? null : { release: async () => { calls.released++; } };
      } },
  });
  return { calls, state, invoke: (input = { expectedProcessUuid: processUuid }, user = actor,
    kind = options.kind || "DRAFT", id = options.kind === "CREDIT" ? 50 : 31) =>
    backend.refreshOperationalSignature(kind, id, input, user) };
}

test("consulta el mismo proceso pendiente y registra usuario real sin exponer documentos ni contactos", async () => {
  const f = fixture();
  const result = await f.invoke();
  assert.equal(result.item.signature.status, "PENDING");
  assert.equal(result.item.signature.processUuid, processUuid);
  assert.equal(result.item.capabilities.canRedirectPendingSignature, true);
  assert.match(result.message, /mismo documento.*pendiente/);
  assert.equal(f.calls.provider, 1);
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.role, 3);
  assert.deepEqual(f.calls.audits.map(row => row[7]), ["SIGNATURE_REFRESH_REQUESTED", "SIGNATURE_REFRESH_PENDING"]);
  assert.ok(f.calls.audits.every(row => row[4] === actor.id && row[5] === "Verified analyst"));
  assert.doesNotMatch(JSON.stringify(result), /must stay|private provider|signedDocumentBase64|requestPayload/);
  assert.ok(f.calls.queries.some(sql => sql.includes("u.\"activo\"=TRUE") && sql.includes("'FINSERPAY'")));
});

test("solo un PDF verificado produce firmado; completado sin PDF y fallos terminales siguen protegidos", async () => {
  const signed = fixture({ signedPdf: true });
  assert.equal((await signed.invoke()).item.signature.status, "SIGNED");
  for (const providerStatus of ["COMPLETED", "EXPIRED", "FAILED", "UNKNOWN_PROVIDER_STATE"]) {
    const f = fixture({ providerStatus });
    const result = await f.invoke();
    assert.equal(result.item.signature.status, "TECHNICAL_ERROR", providerStatus);
    assert.equal(result.item.capabilities.canRedirectPendingSignature, false, providerStatus);
    assert.match(result.message, providerStatus === "COMPLETED" ? /firma completada.*PDF firmado/ : /requiere revisión técnica/);
  }
});

test("bloquea usuario revocado, proceso distinto, duplicados, asociación equivocada y solicitud cerrada", async () => {
  for (const options of [
    { state: { roleActive: false } }, { state: { available: false } },
    { state: { duplicated: true } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.invoke());
    assert.equal(f.calls.provider, 0);
    assert.equal(f.calls.audits.length, 0);
    assert.equal(f.calls.released, 0);
  }
  for (const change of [process => { process.creditoId = 50; },
    process => { process.draftId = 99; }, process => { process.supersededAt = new Date(); }]) {
    const f = fixture(); change(f.state.process);
    await assert.rejects(f.invoke(), { code: "PROCESS_CHANGED" });
    assert.equal(f.calls.provider, 0);
  }
  const stale = fixture();
  await assert.rejects(stale.invoke({ expectedProcessUuid: "20000000-0000-4000-8000-000000000002" }), { code: "PROCESS_CHANGED" });
  assert.equal(stale.calls.provider, 0);
});

test("valida parámetros y límite del lock antes de consultar al proveedor", async () => {
  const f = fixture();
  for (const value of [null, "not-a-uuid", 12])
    await assert.rejects(f.invoke({ expectedProcessUuid: value }), { code: "INVALID_PROCESS" });
  await assert.rejects(f.invoke(undefined, { id: 0, nombre: "Analyst" }), { code: "UNAUTHORIZED" });
  await assert.rejects(f.invoke(undefined, actor, "DRAFT", 2_147_483_648));
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.lock, 0);
});

test("un lock ocupado o error del proveedor no dispara otro envío ni falsifica un resultado", async () => {
  const busy = fixture({ busy: true });
  await assert.rejects(busy.invoke(), { code: "SIGNATURE_BUSY" });
  assert.equal(busy.calls.provider, 0);
  const failure = fixture({ providerError: true });
  await assert.rejects(failure.invoke(), error => error.code === "SIGNATURE_PROVIDER_UNAVAILABLE" &&
    error.status === 502 && !error.message.includes("private upstream"));
  assert.deepEqual(failure.calls.audits.map(row => row[7]), ["SIGNATURE_REFRESH_REQUESTED", "SIGNATURE_REFRESH_UNAVAILABLE"]);
  assert.equal(failure.calls.released, 1);
});

test("crédito vinculado consulta el mismo proceso con lock del origen y conserva la alerta si falta el PDF", async () => {
  const f = fixture({ kind: "CREDIT", providerStatus: "COMPLETED" });
  const result = await f.invoke();
  assert.equal(result.item.kind, "CREDIT");
  assert.equal(result.item.signature.status, "TECHNICAL_ERROR");
  assert.match(result.message, /firma completada.*PDF firmado/);
  assert.equal(f.calls.lock, 1);
  assert.equal(f.calls.released, 1);
  assert.ok(f.calls.queries.some(sql => /FROM "Credito".*WHERE/s.test(sql) && /FOR SHARE/.test(sql)));
  assert.ok(f.calls.audits.every(row => row[1] === "CREDIT" && row[2] === 50 && row[3] === 50));
  for (const afterProvider of [state => { state.process.creditoId = 51; },
    state => { state.process.draftId = 99; }, state => { state.process.supersededAt = new Date(); }]) {
    const changed = fixture({ kind: "CREDIT", afterProvider });
    await assert.rejects(changed.invoke());
    assert.equal(changed.calls.released, 1);
    assert.equal(changed.calls.audits.length, 1);
  }
});

test("la consulta limitada recupera el PDF sin sincronizar contratos ni volver a tomar locks del borrador", async () => {
  const calls = { updated: 0, terminal: 0, credit: 0, boundedGets: [] };
  const pdf = Buffer.from("%PDF-1.7\nprovider signed document").toString("base64");
  const bounded = (name, options, payload) => {
    assert.equal(options?.timeoutMs, 20_000, name);
    calls.boundedGets.push(name);
    return payload;
  };
  const provider = {
    firmaSeguroSignIn: async () => ({ token: "private-token", payload: {} }),
    firmaSeguroGetProcessStatus: async (_token, _uuid, options) => bounded("process", options, { status: "SIGNED" }),
    firmaSeguroGetSignaturesStatus: async (_token, _uuid, options) => bounded("signatures", options, { status: "SIGNED" }),
    extractFirmaSeguroStatus: payload => payload?.status || "",
    isFirmaSeguroCompletedStatus: value => value === "SIGNED",
    collectFirmaSeguroUuidCandidates: () => [],
    firmaSeguroGetDocumentsByUuid: async (_uuid, _token, options) => bounded("documents", options, { base64: pdf }),
    extractFirmaSeguroSignedDocument: payload => ({ base64: payload.base64, fileName: "signed.pdf", url: "" }),
    summarizeFirmaSeguroDocumentPayload: () => ({}),
  };
  const backend = load("lib/firmaseguro-credit.ts", {
    "@/lib/firmaseguro": provider,
    "@/lib/prisma": { default: { $transaction: async () => { calls.credit++; throw new Error("Unexpected contractual synchronization"); } } },
    "@/lib/firmaseguro-storage": { updateFirmaSeguroProcess: async (uuid, values) => {
      calls.updated++; return { processUuid: uuid, ...values, creditoId: 50, draftId: 31 };
    } },
    "@/lib/approval-operational-signature-complete": {
      markOperationalSignatureTerminalFailure: async () => { calls.terminal++; },
    },
    "@/lib/approval-initial-signature": {
      markInitialApprovalSignatureTerminalFailure: async () => { calls.terminal++; },
    },
  }, true);
  for (const creditoId of [50, null]) {
    const result = await backend.refreshFirmaSeguroProcess({ processUuid, creditoId, draftId: 31,
      draftPayload: { firmaSeguroClientCorrectionId: "must-not-run-a-completion" },
      supersededAt: null, status: "SIGNED", completedAt: new Date(), signedDocumentBase64: null,
    }, { synchronizeContractState: false, providerTimeoutMs: 20_000 });
    assert.equal(result.signedDocumentBase64, pdf);
    assert.equal(result.lastError, null);
  }
  assert.equal(calls.updated, 2);
  assert.equal(calls.credit, 0);
  assert.equal(calls.terminal, 0);
  provider.firmaSeguroGetDocumentsByUuid = async (_uuid, token, options) =>
    bounded(token ? "by-uuid-auth" : "by-uuid-public", options, {});
  provider.firmaSeguroGetAuraQuanticDocumentByUuid = async (_uuid, _token, options) => bounded("aura", options, {});
  provider.firmaSeguroGetDocumentByUuid = async (_uuid, token, options) =>
    bounded(token ? "document-auth" : "document-public", options, token ? { base64: pdf } : {});
  const fallback = await backend.refreshFirmaSeguroProcess({ processUuid, creditoId: 50, draftId: 31,
    supersededAt: null, status: "SIGNED", completedAt: new Date(), signedDocumentBase64: null,
  }, { synchronizeContractState: false, providerTimeoutMs: 20_000 });
  assert.equal(fallback.signedDocumentBase64, pdf);
  for (const name of ["process", "signatures", "by-uuid-public", "by-uuid-auth", "aura", "document-public", "document-auth"])
    assert.ok(calls.boundedGets.includes(name), name);
  const archived = { processUuid, supersededAt: new Date(), creditoId: 50 };
  assert.equal(await backend.refreshFirmaSeguroProcess(archived, { synchronizeContractState: false }), archived);
  assert.equal(calls.updated, 3);
});

test("no devuelve una firma que cambió de solicitud ni omite una revocación durante la consulta", async () => {
  for (const afterProvider of [state => { state.process.creditoId = 50; },
    state => { state.roleActive = false; }, state => { state.duplicated = true; }]) {
    const f = fixture({ afterProvider });
    await assert.rejects(f.invoke());
    assert.equal(f.calls.provider, 1);
    assert.equal(f.calls.audits.length, 1, "conserva el intento inicial y no registra confirmación inválida");
    assert.equal(f.calls.released, 1);
  }
});

function routeFixture({ user = actor, shared, body, origin = "https://finser.test" } = {}) {
  const calls = [];
  const auth = { getCreditApprovalSessionUser: async () => user };
  const sharedSession = { getApprovalSharedRequestActor: async () => shared };
  const approvalHttp = load("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": auth,
    "@/lib/approval-shared-session": sharedSession,
    "@/lib/credit-approval": { CreditApprovalError },
  }, true);
  const http = load("lib/approval-operations-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": auth,
    "@/lib/approval-shared-session": sharedSession,
    "@/lib/credit-approval": { CreditApprovalError },
    "@/lib/credit-approval-http": approvalHttp,
    "@/lib/approval-operations-read": reader,
    "@/lib/approval-operations-write": { ApprovalOperationalError },
  }, true);
  const route = load("app/api/aprobaciones/operativo/[kind]/[id]/firma/actualizar/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/approval-operations-http": http,
    "@/lib/approval-operational-signature-refresh": { refreshOperationalSignature: async (...args) => {
      calls.push(args); return { item: { signature: { status: "PENDING" } }, message: "Estado consultado" };
    } },
  });
  return { calls, invoke: () => route.POST(new Request("https://finser.test/api/aprobaciones/operativo/DRAFT/31/firma/actualizar", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body || { expectedProcessUuid: processUuid }),
  }), { params: Promise.resolve({ kind: "DRAFT", id: "31" }) }) };
}

test("ruta nominal exige cuenta propia, origen y el UUID del proceso; responde sin caché", async () => {
  const valid = routeFixture();
  const response = await valid.invoke();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(valid.calls.length, 1);
  assert.equal(valid.calls[0][3].id, actor.id);
  for (const [options, status] of [
    [{ user: null }, 401], [{ shared: { token: "shared" } }, 403],
    [{ origin: "https://untrusted.test" }, 403],
    [{ body: { expectedProcessUuid: processUuid, actorUserId: 100 } }, 400],
    [{ body: "malformed" }, 400],
  ]) {
    const denied = routeFixture(options);
    assert.equal((await denied.invoke()).status, status);
    assert.equal(denied.calls.length, 0);
  }
});
