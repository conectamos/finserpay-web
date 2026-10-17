import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { creditApprovalDocumentRefreshSchemaStatements } from "../scripts/credit-approval-document-refresh-schema.mjs";
import { loadApprovalModule, approvalActors, service } from "./credit-approval-test-loader.mjs";

const processUuid = "10000000-0000-4000-8000-000000000001";
const grantId = "20000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const sharedActor = { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido", grantId, sessionId };
const userActor = { id: 7, nombre: "Old session name" };
class ApprovalOperationalError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

function fixture(options = {}) {
  const calls = { provider: 0, audit: [], released: 0, queries: [], user: 0 };
  const state = { active: true, allowed: true, userActive: true, origin: true,
    duplicate: false, available: true, process: { processUuid, creditoId: 50, draftId: 31,
      supersededAt: null, completedAt: new Date(), status: "EXITOSO", signedDocumentBase64: null } };
  function operationalDetail() {
    return { kind: "CREDIT", id: 50, signature: { processUuid: state.process.processUuid,
      status: state.process.signedDocumentBase64 ? "SIGNED" : "TECHNICAL_ERROR" } };
  }
  const db = {
    async $queryRawUnsafe(sql) {
      calls.queries.push(sql);
      if (sql.includes('FROM "CreditApprovalSharedGrant"')) return state.active ? [{ id: sessionId }] : [];
      if (sql.includes('JOIN "CreditApprovalPolicy"')) return state.allowed ? [{ id: 50 }] : [];
      if (sql.includes('FROM "Credito"')) return [{ id: 50 }];
      if (sql.includes('FROM "CreditoBorrador"')) return state.origin ? [{ id: 31 }] : [];
      if (sql.includes('FROM "FirmaSeguroProcess"')) return state.duplicate
        ? [{ ...state.process }, { ...state.process }] : [{ ...state.process }];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...params) {
      assert.match(sql, /INSERT INTO "CreditApprovalDocumentRefreshEvent"/);
      assert.doesNotMatch(sql, /contratoSnapshot|CreditApprovalEvent|CreditApprovalReview|UPDATE "Credito"/);
      calls.audit.push(params); return 1;
    },
  };
  const prisma = { $transaction: async fn => fn(db) };
  const refresh = loadApprovalModule("lib/approval-operational-signature-refresh.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/analyst-mora-access": {},
    "@/lib/approval-operations-schema": {},
    "@/lib/approval-operations-read": {
      operationalCaseIdentity: (kind, id) => ({ kind, id: Number(id) }),
      getOperationalCase: async () => operationalDetail(),
    },
    "@/lib/approval-operations-write": { ApprovalOperationalError },
    "@/lib/firmaseguro-status": { isFirmaSeguroSuccessfulStatus: value => value === "EXITOSO" },
    "@/lib/firmaseguro-credit": { refreshFirmaSeguroProcess: async (process, settings) => {
      calls.provider++;
      assert.equal(process.processUuid, processUuid);
      assert.equal(settings.synchronizeContractState, false);
      assert.equal(settings.providerTimeoutMs, 20_000);
      if (options.providerError) throw new Error("Private provider error");
      if (options.recovered !== false) state.process.signedDocumentBase64 = "JVBERi0test";
      options.afterProvider?.(state);
    } },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {},
      tryAcquireSolicitudOperationLock: async id => {
        assert.equal(id, 31);
        return { release: async () => { calls.released++; } };
      } },
  });
  const adapter = loadApprovalModule("lib/credit-approval-document-refresh.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-approval-actor": approvalActors,
    "@/lib/credit-approval": { CreditApprovalError: service.CreditApprovalError,
      getCreditApprovalDetail: async () => ({ id: 50, document: {
        processUuid: state.process.processUuid, available: state.available && Boolean(state.process.signedDocumentBase64),
        href: "/api/aprobaciones/50/documento" } }) },
    "@/lib/analyst-mora-access": { assertMoraActor: async (_db, actor) => {
      calls.user++;
      if (!state.userActive) throw new service.CreditApprovalError("FORBIDDEN", "Revoked", 403);
      return { ...actor, nombre: "Verified current user" };
    } },
    "@/lib/approval-operations-write": { ApprovalOperationalError },
    "@/lib/approval-operational-signature-refresh": refresh,
    "@/lib/credit-approval-document-refresh-schema": { ensureCreditApprovalDocumentRefreshSchema: async () => {} },
  });
  return { calls, state, invoke: (actor = sharedActor, expected = processUuid) =>
    adapter.refreshCreditApprovalDocument(50, { expectedProcessUuid: expected }, actor) };
}

test("acceso compartido vigente recupera solo el PDF del mismo crédito y audita grant/sesión sin inventar usuario", async () => {
  const f = fixture();
  const result = await f.invoke();
  assert.equal(result.item.document.available, true);
  assert.equal(f.calls.provider, 1);
  assert.equal(f.calls.user, 0);
  assert.equal(f.calls.released, 1);
  assert.deepEqual(f.calls.audit.map(row => row[8]), ["REQUESTED", "RECOVERED"]);
  assert.ok(f.calls.audit.every(row => row[1] === 50 && row[2] === processUuid && row[3] === "SHARED_LINK"
    && row[4] === null && row[6] === grantId && row[7] === sessionId));
  assert.ok(f.calls.queries.some(sql => sql.includes("approvedRevision") && sql.includes('"LiquidacionAliadoCredito"')),
    "preserva el permiso de lectura actual de aprobados, sin abrir todo el histórico");
});

test("usuario nominal se valida en BD y el intento conserva su identidad real", async () => {
  const f = fixture();
  await f.invoke(userActor);
  assert.ok(f.calls.user >= 3);
  assert.ok(f.calls.audit.every(row => row[3] === "USER" && row[4] === 7 && row[5] === "Verified current user"
    && row[6] === null && row[7] === null));
});

test("firma completada sin PDF mantiene el documento bloqueado y registra indisponible", async () => {
  const f = fixture({ recovered: false });
  const result = await f.invoke();
  assert.equal(result.item.document.available, false);
  assert.match(result.message, /firma completada.*PDF firmado/);
  assert.deepEqual(f.calls.audit.map(row => row[8]), ["REQUESTED", "UNAVAILABLE"]);
  assert.doesNotMatch(JSON.stringify(result), /base64|signedDocumentBase64|Private provider/);
  const unverified = fixture(); unverified.state.available = false;
  const blocked = await unverified.invoke();
  assert.equal(blocked.item.document.available, false);
  assert.match(blocked.message, /todavía no está disponible/);
  assert.deepEqual(unverified.calls.audit.map(row => row[8]), ["REQUESTED", "UNAVAILABLE"],
    "un estado firmado sin documento utilizable en aprobaciones no acredita recuperación");
});

test("deniega grant revocado, crédito fuera de alcance, origen ausente, UUID distinto o firmas ambiguas antes del GET", async () => {
  for (const change of [state => { state.active = false; }, state => { state.allowed = false; },
    state => { state.origin = false; }, state => { state.duplicate = true; }]) {
    const f = fixture(); change(f.state);
    await assert.rejects(f.invoke());
    assert.equal(f.calls.provider, 0); assert.equal(f.calls.audit.length, 0);
  }
  const stale = fixture();
  await assert.rejects(stale.invoke(sharedActor, "40000000-0000-4000-8000-000000000004"), { code: "PROCESS_CHANGED" });
  assert.equal(stale.calls.provider, 0);
  const revokedUser = fixture(); revokedUser.state.userActive = false;
  await assert.rejects(revokedUser.invoke(userActor), { status: 403 });
  assert.equal(revokedUser.calls.provider, 0);
});

test("revalida alcance y proceso después del proveedor sin devolver éxito para otra versión", async () => {
  for (const afterProvider of [state => { state.active = false; }, state => { state.allowed = false; },
    state => { state.process.supersededAt = new Date(); }, state => { state.process.creditoId = 51; }]) {
    const f = fixture({ afterProvider });
    await assert.rejects(f.invoke());
    assert.equal(f.calls.provider, 1); assert.equal(f.calls.audit.length, 1); assert.equal(f.calls.released, 1);
  }
  const unavailable = fixture({ providerError: true });
  await assert.rejects(unavailable.invoke(), { code: "SIGNATURE_PROVIDER_UNAVAILABLE", status: 502 });
  assert.deepEqual(unavailable.calls.audit.map(row => row[8]), ["REQUESTED", "UNAVAILABLE"]);
});

test("POST del documento usa origen y cuerpo limitado y GET conserva su permiso de lectura", async () => {
  const calls = [];
  const http = loadApprovalModule("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": {}, "@/lib/roles": {},
    "@/lib/approval-shared-session": {}, "@/lib/credit-approval-actor": approvalActors,
    "@/lib/credit-approval": service,
  });
  const route = loadApprovalModule("app/api/aprobaciones/[id]/documento/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/credit-approval": { approvalCreditId: service.approvalCreditId, CreditApprovalError: service.CreditApprovalError,
      getApprovalDocument: async () => ({ bytes: Buffer.from("%PDF-test"), fileName: "signed.pdf" }) },
    "@/lib/credit-approval-actor": { assertApprovalActorCreditReadAccess: async () => { calls.push("GET-scope"); } },
    "@/lib/credit-approval-http": { ...http, getApprovalActor: async () => sharedActor },
    "@/lib/prisma": { default: { $transaction: async fn => fn({}) } },
    "@/lib/credit-approval-document-refresh": { refreshCreditApprovalDocument: async (id, body, actor) => {
      assert.equal(id, 50); assert.equal(actor, sharedActor); assert.equal(body.expectedProcessUuid, processUuid);
      calls.push("refresh"); return { item: { id, document: { available: false } }, message: "PDF pendiente" };
    } },
  });
  const context = { params: Promise.resolve({ id: "50" }) };
  function request(body, origin = "https://finser.test") {
    return new Request("https://finser.test/api/aprobaciones/50/documento", { method: "POST",
      headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  }
  const result = await route.POST(request({ expectedProcessUuid: processUuid }), context);
  assert.equal(result.status, 200); assert.equal((await result.json()).item.document.available, false);
  assert.equal(result.headers.get("vary"), "Cookie");
  assert.match(result.headers.get("cache-control"), /private, no-store/);
  for (const body of [{}, [], null, { expectedProcessUuid: processUuid, revision: 2 }])
    assert.equal((await route.POST(request(body), context)).status, 400);
  assert.equal((await route.POST(request({ expectedProcessUuid: processUuid }, "https://untrusted.test"), context)).status, 403);
  const get = await route.GET(new Request("https://finser.test/api/aprobaciones/50/documento"), context);
  assert.equal(get.status, 200); assert.deepEqual(calls, ["refresh", "GET-scope"]);
});

test("auditoría nueva conserva actores reales y no se puede editar, eliminar ni truncar", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "CreditApprovalSharedGrant" ("id" UUID PRIMARY KEY);
      CREATE TABLE "CreditApprovalSharedSession" ("id" UUID PRIMARY KEY);
      INSERT INTO "Credito" VALUES (50); INSERT INTO "Usuario" VALUES (7);
      INSERT INTO "CreditApprovalSharedGrant" VALUES ('${grantId}');
      INSERT INTO "CreditApprovalSharedSession" VALUES ('${sessionId}');`);
    for (const sql of creditApprovalDocumentRefreshSchemaStatements()) await db.exec(sql);
    await db.exec(`CREATE TABLE "FirmaSeguroProcess" ("processUuid" TEXT PRIMARY KEY);
      INSERT INTO "FirmaSeguroProcess" VALUES ('${processUuid}');`);
    for (let i = 0; i < 2; i++) for (const sql of creditApprovalDocumentRefreshSchemaStatements()) await db.exec(sql);
    const foreignKey = await db.query(`SELECT conname FROM pg_constraint
      WHERE conname='CreditApprovalDocumentRefreshEvent_process_fkey'`);
    assert.equal(foreignKey.rows.length, 1, "agrega la FK al inicializar FirmaSeguro sin romper un predeploy nuevo");
    await db.query(`INSERT INTO "CreditApprovalDocumentRefreshEvent"
      ("id","creditoId","processUuid","actorKind","actorName","actorGrantId","actorSessionId","status")
      VALUES ('40000000-0000-4000-8000-000000000004',50,$1,'SHARED_LINK','Acceso compartido',$2,$3,'REQUESTED')`,
      [processUuid, grantId, sessionId]);
    for (const statement of ['UPDATE "CreditApprovalDocumentRefreshEvent" SET "status"=\'RECOVERED\'',
      'DELETE FROM "CreditApprovalDocumentRefreshEvent"', 'TRUNCATE "CreditApprovalDocumentRefreshEvent"'])
      await assert.rejects(db.exec(statement), /APPROVAL_DOCUMENT_REFRESH_AUDIT_IMMUTABLE/);
    await assert.rejects(db.query(`INSERT INTO "CreditApprovalDocumentRefreshEvent"
      ("id","creditoId","processUuid","actorKind","actorUserId","actorName","status")
      VALUES ('50000000-0000-4000-8000-000000000005',50,$1,'SHARED_LINK',7,'Invented user','RECOVERED')`, [processUuid]));
    const installer = readFileSync(new URL("../scripts/railway-predeploy.mjs", import.meta.url), "utf8");
    assert.ok(installer.includes('await import("./ensure-credit-approval-document-refresh-schema.mjs")'));
    assert.ok(installer.indexOf("ensure-approval-shared-schema.mjs") < installer.indexOf("ensure-credit-approval-document-refresh-schema.mjs"));
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    for (const name of ["credit-approval-document-refresh-schema.mjs", "ensure-credit-approval-document-refresh-schema.mjs"])
      assert.ok(dockerfile.includes(`/app/scripts/${name}`));
  } finally { await db.close(); }
});
