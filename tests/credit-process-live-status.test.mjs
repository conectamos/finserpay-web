import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createCreditProcessStatusPoller, CREDIT_PROCESS_STATUS_INTERVAL_MS } from "../lib/credit-process-status-polling.ts";
import { canOperateSolicitud, isDirectSalesProfile } from "../lib/solicitud-operation-access.ts";
import { buildVeriffRetryPolicy } from "../lib/veriff-retry-policy-core.ts";
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const { readFinancingTermsSeal } = await jiti.import("../lib/credit-amortization-contract.ts");
const { readFrozenCorrectionDateSource } = await jiti.import("../lib/firmaseguro-draft-frozen.ts");
const summarySource = await readFile(new URL("../lib/credit-process-status-summary.ts", import.meta.url), "utf8");
const correctionSource = summarySource.slice(summarySource.indexOf("function object("), summarySource.indexOf("/** Uses the sealed contract"));
const resolveStoredDraftCorrectionPending = runInNewContext(stripTypeScriptTypes(correctionSource.replace("export function", "function")) + "\nresolveStoredDraftCorrectionPending", { readFinancingTermsSeal, readFrozenCorrectionDateSource });

const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (overrides = {}) => ({ ok: true, draftId: 25, revision: { processId: 7 }, pending: true, ...overrides });
function fixture(read = async () => snapshot()) {
  const scheduled = new Map();
  const snapshots = [];
  const connections = [];
  let available = true;
  let pending = true;
  let timer = 0;
  let requests = 0;
  const poller = createCreditProcessStatusPoller({
    binding: { draftId: 25, validationId: 2, processUuid: "current" },
    canRead: () => available, isPending: () => pending,
    read: async (...args) => { requests += 1; return read(...args); },
    onSnapshot: value => snapshots.push(value),
    onConnection: (...args) => connections.push(args),
    schedule: (callback, delay) => { const id = ++timer; scheduled.set(id, { callback, delay }); return id; },
    cancel: id => scheduled.delete(id),
  });
  return { poller, scheduled, snapshots, connections, requests: () => requests,
    setAvailable: value => { available = value; }, setPending: value => { pending = value; },
    async next() { const [id, task] = scheduled.entries().next().value; scheduled.delete(id); task.callback(); await tick(); },
  };
}

test("consulta únicamente cada cinco segundos mientras exista un proceso pendiente", async () => {
  const f = fixture();
  await f.poller.start();
  assert.equal(CREDIT_PROCESS_STATUS_INTERVAL_MS, 5000);
  assert.equal(f.scheduled.size, 1);
  assert.equal([...f.scheduled.values()][0].delay, 5000);
  await f.next();
  assert.equal(f.requests(), 2);
  f.poller.dispose();
  assert.equal(f.scheduled.size, 0);
});

test("reintentar y enfocar no duplican una consulta que todavía está en curso", async () => {
  let resolve;
  let signal;
  const f = fixture(async (_binding, currentSignal) => { signal = currentSignal; return new Promise(done => { resolve = done; }); });
  const initial = f.poller.start();
  await f.poller.retry();
  await f.poller.retry();
  assert.equal(f.requests(), 1);
  assert.equal(signal.aborted, false);
  resolve(snapshot());
  await initial;
  assert.equal(f.snapshots.length, 1);
  f.poller.dispose();
});

test("una respuesta tardía de la solicitud o versión anterior se descarta al salir", async () => {
  let resolve;
  let signal;
  const f = fixture(async (_binding, currentSignal) => { signal = currentSignal; return new Promise(done => { resolve = done; }); });
  const initial = f.poller.start();
  f.poller.dispose();
  assert.equal(signal.aborted, true);
  resolve(snapshot({ process: { processUuid: "old-signed", status: "SIGNED" } }));
  await initial;
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.scheduled.size, 0);
});

test("una respuesta de otro borrador nunca confirma el contrato actual", async () => {
  const f = fixture(async () => snapshot({ draftId: 26 }));
  await f.poller.start();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.connections.at(-1)[0], "reconnecting");
  assert.match(f.connections.at(-1)[1], /solicitud vigente/);
  f.poller.dispose();
});

test("confirmación final detiene las consultas pero volver a la pantalla revalida", async () => {
  const f = fixture(async () => snapshot({ pending: false }));
  await f.poller.start();
  assert.equal(f.scheduled.size, 0);
  await f.poller.retry();
  assert.equal(f.requests(), 2);
  assert.equal(f.scheduled.size, 0);
  f.poller.dispose();
});

test("error de conexión retira conectado y reintenta sin enviar operaciones", async () => {
  let failure = false;
  const f = fixture(async () => { if (failure) throw new Error("Servidor no disponible"); return snapshot(); });
  await f.poller.start();
  assert.equal(f.connections.at(-1)[0], "connected");
  failure = true;
  await f.next();
  assert.deepEqual(f.connections.at(-1), ["reconnecting", "Servidor no disponible"]);
  assert.equal(f.scheduled.size, 1);
  failure = false;
  await f.poller.retry();
  assert.deepEqual(f.connections.at(-1), ["connected", null]);
  f.poller.dispose();
});

test("ocultar o desconectar aborta la lectura y al volver consulta el servidor", async () => {
  const f = fixture();
  await f.poller.start();
  f.setAvailable(false);
  f.poller.pause();
  assert.equal(f.scheduled.size, 0);
  await f.poller.retry();
  assert.equal(f.requests(), 1);
  assert.equal(f.connections.at(-1)[0], "reconnecting");
  f.setAvailable(true);
  await f.poller.retry();
  assert.equal(f.requests(), 2);
  f.setPending(false);
  await f.poller.retry();
  assert.equal(f.scheduled.size, 0);
  f.poller.dispose();
});

test("el hook revalida foco, visibilidad y online; limpia listeners y sólo usa GET local", async () => {
  const source = await readFile(new URL("../app/dashboard/creditos/use-credit-process-live-status.ts", import.meta.url), "utf8");
  assert.match(source, /estado-proceso/);
  assert.match(source, /method: "GET"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /isCurrentBinding/);
  for (const event of ["visibilitychange", "focus", "online", "offline"]) {
    assert.ok(source.includes(`addEventListener("${event}"`));
    assert.ok(source.includes(`removeEventListener("${event}"`));
  }
  assert.match(source, /current\.dispose\(\)/);
  assert.doesNotMatch(source, /refresh=1|veriffGet|firmaSeguroCreate|method: "POST"|setWizardStep/);
});

const routeSource = await readFile(new URL("../app/api/creditos/borradores/[id]/estado-proceso/route.ts", import.meta.url), "utf8");
const source = routeSource.replace(/^import[\s\S]*?from\s+"[^"\n]+";\s*$/gm, "").replace(/^export const /gm, "const ").replace("export async function GET", "async function GET");
function routeFixture({ user = { id: 10, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1 }, seller = null, row = {}, error = false } = {}) {
  const calls = [];
  const fixtureRow = { id: 25, vendedorId: 40, aliadoId: 2, estado: "ABIERTO", updatedAt: "2026-10-09T00:00:00.000Z", payload: {}, validation: { id: 9, pending: true, draftId: 25 }, process: { id: 8, processUuid: "actual", status: "IN_PROGRESS" }, declinedAttempts: 0, ...row };
  const GET = runInNewContext(stripTypeScriptTypes(source) + "\nGET", {
    NextResponse: Response, Date, Number,
    getSessionUser: async () => user,
    getSellerSessionUser: async () => seller,
    isAdminRole: role => role === "ADMIN",
    isFinserPayCentralAlly: code => code === "FINSERPAY",
    canOperateSolicitud, isDirectSalesProfile, buildVeriffRetryPolicy,
    serializeVeriffValidation: value => value,
    serializeStoredDraftSignature: value => value,
    redactVeriffValidationForOperator: value => value && { id: value.id, draftId: value.draftId, pending: value.pending },
    resolveFirmaSeguroProcessUiState: value => !value ? "pending" : value.status === "SIGNED" ? "signed" : "waiting",
    resolveStoredDraftCorrectionPending,
    prisma: { $queryRawUnsafe: async (sql, id) => { calls.push({ sql, id }); if (error) throw new Error("private database diagnostic"); return [fixtureRow]; } },
  });
  return { calls, invoke: (id = "25") => GET(new Request("https://example.test"), { params: Promise.resolve({ id }) }) };
}

test("lectura de estados usa una sola instantánea, firma vigente y validación más reciente", async () => {
  const f = routeFixture();
  const response = await f.invoke();
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.draftId, 25);
  assert.equal(data.revision.validationId, 9);
  assert.equal(data.revision.processId, 8);
  assert.equal(data.process.processUuid, "actual");
  assert.equal(data.pending, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, 25);
  assert.match(f.calls[0].sql, /"supersededAt" IS NULL/);
  assert.match(f.calls[0].sql, /ORDER BY v\."id" DESC LIMIT 1/);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.doesNotMatch(routeSource, /veriffGetDecision|veriffGetPerson|refreshFirmaSeguroProcess|finalizeDraftDispatch|\$executeRaw|UPDATE |INSERT |DELETE |ensure\w+Schema\(/);
});

test("administrador de aliado y asesor sólo pueden leer su alcance", async () => {
  const allyAdmin = routeFixture({ user: { rolNombre: "ADMIN", aliadoAccesoCodigo: "OTHER", aliadoAccesoId: 3 } });
  assert.equal((await allyAdmin.invoke()).status, 404);
  const owner = routeFixture({ user: { rolNombre: "ASESOR", aliadoId: 2 }, seller: { id: 40, tipoPerfil: "VENDEDOR" } });
  assert.equal((await owner.invoke()).status, 200);
  const other = routeFixture({ user: { rolNombre: "ASESOR", aliadoId: 2 }, seller: { id: 41, tipoPerfil: "SUPERVISOR" } });
  assert.equal((await other.invoke()).status, 404);
  const outsider = routeFixture({ user: { rolNombre: "ASESOR", aliadoId: 3 }, seller: { id: 40, tipoPerfil: "VENDEDOR" } });
  assert.equal((await outsider.invoke()).status, 404);
});

test("sin sesión o perfil comercial no consulta datos y protege errores internos", async () => {
  const anonymous = routeFixture({ user: null });
  assert.equal((await anonymous.invoke()).status, 401);
  assert.equal(anonymous.calls.length, 0);
  const blocked = routeFixture({ user: { rolNombre: "ASESOR" }, seller: { tipoPerfil: "ANALISTA" } });
  assert.equal((await blocked.invoke()).status, 403);
  assert.equal(blocked.calls.length, 0);
  assert.equal((await routeFixture().invoke("1 OR 1=1")).status, 404);
  const failure = await routeFixture({ error: true }).invoke();
  assert.equal(failure.status, 500);
  assert.doesNotMatch(JSON.stringify(await failure.json()), /private database diagnostic/);
});

test("firma completada detiene polling; banderas de corrección no cambian el histórico", async () => {
  const f = routeFixture({ row: { validation: { id: 9, pending: false }, process: { id: 8, processUuid: "actual", status: "SIGNED" }, payload: { firmaSeguroIdentityCorrectionPending: true } } });
  const data = await (await f.invoke()).json();
  assert.equal(data.pending, false);
  assert.equal(data.identityCorrectionPending, true);
  assert.equal(f.calls.length, 1);
});

test("consulta SQL real descarta la firma y el Veriff antiguos después de una nueva versión", async () => {
  const f = routeFixture();
  await f.invoke();
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE "Sede" ("id" integer PRIMARY KEY, "aliadoId" integer);
      CREATE TABLE "CreditoBorrador" ("id" integer PRIMARY KEY, "vendedorId" integer,
        "sedeId" integer, "estado" text, "updatedAt" timestamptz, "createdAt" timestamptz,
        "expiresAt" timestamptz, "creditoId" integer, "closedReason" text, "payload" jsonb,
        "clienteNombre" text, "clienteDocumento" text, "imei" text);
      CREATE TABLE "VeriffIdentityValidation" ("id" integer PRIMARY KEY, "draftId" integer,
        "creditoId" integer, "status" text, "createdAt" timestamptz, "decidedAt" timestamptz, "updatedAt" timestamptz);
      CREATE TABLE "FirmaSeguroProcess" ("id" integer PRIMARY KEY, "creditoId" integer, "draftId" integer,
        "draftFolio" text, "draftPayload" jsonb, "processUuid" text, "status" text,
        "signedDocumentFileName" text, "lastError" text, "createdAt" timestamptz,
        "updatedAt" timestamptz, "completedAt" timestamptz, "signedDocumentBase64" text, "supersededAt" timestamptz);
      INSERT INTO "Sede" VALUES (1,2);
      INSERT INTO "CreditoBorrador" VALUES (25,40,1,'ABIERTO',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,NULL,NULL,'{}','CLIENTE','00111','001234567890123');
      INSERT INTO "VeriffIdentityValidation" VALUES
        (8,25,NULL,'APPROVED',CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP),
        (9,25,NULL,'PENDING',CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP),
        (10,26,NULL,'APPROVED',CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP);
      INSERT INTO "FirmaSeguroProcess" VALUES
        (7,NULL,25,'OLD','{}','old-signed','SIGNED','old.pdf',NULL,CURRENT_TIMESTAMP-INTERVAL '1 day',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'base64',CURRENT_TIMESTAMP),
        (8,NULL,25,'NEW','{"imei":"001234567890123"}','current','IN_PROGRESS',NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,NULL,NULL),
        (9,NULL,26,'OTHER','{}','other-signed','SIGNED','other.pdf',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'base64',NULL);
    `);
    const result = await database.query(f.calls[0].sql, [25]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].validation.id, 9);
    assert.equal(result.rows[0].process.processUuid, "current");
    assert.equal(result.rows[0].process.signedDocumentBase64, null);
    assert.equal(result.rows[0].process.draftPayload.imei, "001234567890123");
    await database.query(`UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"='signed', "completedAt"=CURRENT_TIMESTAMP WHERE "id"=7`);
    const duplicateOldEvent = await database.query(f.calls[0].sql, [25]);
    assert.equal(duplicateOldEvent.rows[0].process.processUuid, "current");
    assert.equal(duplicateOldEvent.rows[0].process.completedAt, null);
    assert.equal(duplicateOldEvent.rows[0].process.signedPdfVerified, false);
    await database.query(`UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"='JVBERi0xLjQ=', "completedAt"=CURRENT_TIMESTAMP WHERE "id"=8`);
    const actualEvent = await database.query(f.calls[0].sql, [25]);
    assert.equal(actualEvent.rows[0].process.signedDocumentBase64, "stored");
    assert.equal(actualEvent.rows[0].process.signedPdfVerified, true);
    assert.ok(actualEvent.rows[0].process.completedAt);
  } finally {
    await database.close();
  }
});

function correctionFixture() {
  const snapshot = { clienteNombre: "CLIENTE CORREGIDO", documento: "00111", imei: "001234567890123",
    fechaPrimerPago: "2026-10-17", valorVenta: "2500000.000000", cuotaInicial: "500000.000000", numeroCuotas: 20 };
  const checksum = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(snapshot).sort().map(key => [key, snapshot[key]])))).digest("hex");
  const seal = { version: "FINANCIACION_FIRMADA_V2", checksum, snapshot };
  const id = "17dd6120-4b37-4c9e-a3b6-8d26cf85501f";
  const payload = { firmaSeguroIdentityCorrectionPending: true, firmaSeguroIdentityCorrectionId: id,
    firmaSeguroCorrectionPending: true, firmaSeguroCorrectionId: id,
    firmaSeguroFinancialCorrectionPending: true, firmaSeguroFinancialCorrectionId: id,
    firmaSeguroFinancialCorrectionPreviousProcessUuid: "previous-signed",
    valorEquipoTotal: "2500000", cuotaInicial: "500000", plazoMeses: "20" };
  return { draftId: 25, documentNumber: "00111", clientName: "CLIENTE CORREGIDO", imei: "001234567890123", payload,
    process: { id: 8, draftId: 25, processUuid: "current", supersededAt: null, completedAt: "2026-10-09T00:00:00Z", signedPdfVerified: true,
      draftPayload: { ...payload, financialTermsSeal: seal,
        firmaSeguroFrozenCorrectionDateSource: { processUuid: "previous-signed", sourceChecksum: "a".repeat(64), targetChecksum: checksum } } } };
}

test("la nueva firma vigente satisface marcadores atrasados sólo con sello y corrección exactos", () => {
  const f = correctionFixture();
  const result = resolveStoredDraftCorrectionPending(f);
  assert.equal(result.identityCorrectionPending, false);
  assert.equal(result.financialCorrectionPending, false);
  assert.equal(result.imeiCorrectionPending, false);
  assert.equal(f.payload.firmaSeguroIdentityCorrectionPending, true, "la lectura no modifica el borrador ni su auditoría");
});

test("envío sin firma, PDF inválido, versión antigua o datos diferentes no satisfacen correcciones", () => {
  for (const changes of [
    { completedAt: null }, { signedPdfVerified: false }, { supersededAt: "2026-10-09T00:00:00Z" }, { draftId: 26 },
    { draftPayload: { financialTermsSeal: correctionFixture().process.draftPayload.financialTermsSeal } },
  ]) {
    const f = correctionFixture();
    Object.assign(f.process, changes);
    const result = resolveStoredDraftCorrectionPending(f);
    assert.equal(result.identityCorrectionPending, true);
    assert.equal(result.financialCorrectionPending, true);
    assert.equal(result.imeiCorrectionPending, true);
  }
  for (const changes of [{ documentNumber: "111" }, { imei: "101234567890123" }, { clientName: "CLIENTE ANTERIOR" }]) {
    const result = resolveStoredDraftCorrectionPending({ ...correctionFixture(), ...changes });
    assert.equal(result.identityCorrectionPending, true);
    assert.equal(result.financialCorrectionPending, true);
  }
  const wrongFinancial = correctionFixture();
  wrongFinancial.payload.cuotaInicial = "600000";
  assert.equal(resolveStoredDraftCorrectionPending(wrongFinancial).financialCorrectionPending, true);
  const oldVersion = correctionFixture();
  oldVersion.process.processUuid = "previous-signed";
  assert.equal(resolveStoredDraftCorrectionPending(oldVersion).identityCorrectionPending, true);
  assert.equal(resolveStoredDraftCorrectionPending(oldVersion).financialCorrectionPending, true);
  const badSeal = correctionFixture();
  badSeal.process.draftPayload.financialTermsSeal.snapshot.imei = "101234567890123";
  assert.equal(resolveStoredDraftCorrectionPending(badSeal).identityCorrectionPending, true);
});
