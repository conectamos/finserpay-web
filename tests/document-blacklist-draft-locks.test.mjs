import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
function load(source, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, {
    exports: loaded.exports, module: loaded,
    require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; },
    ...globals,
  });
  return loaded.exports;
}
const core = load(read("lib/document-blacklist-core.ts"));
const helpers = load(read("lib/solicitud-blacklist-locks.ts"), { "@/lib/document-blacklist-core": core });
const canonical = load(read("lib/solicitudes.ts"));
const storage = read("lib/solicitudes-storage.ts");
const saveSource = storage.slice(storage.indexOf("export async function saveSolicitudDraft("), storage.indexOf("export class SolicitudDataCreditoLinkError"));
const sameOwnerSource = storage.slice(storage.indexOf("function sameOwner("), storage.indexOf("async function lockIdentity("));
const baseRow = {
  id: 11, usuarioId: 4, vendedorId: 8, sedeId: 3, currentStep: 4,
  clienteDocumento: "1062402825", imei: null, plataforma: "IPHONE", materialized: true,
  dataCreditoAssessmentId: "b1763a64-1ac7-48d9-9641-7d8181a4e101",
  payload: { clienteDocumento: "1062402825", clientePrimerApellido: "APELLIDO" },
};
const baseInput = {
  id: 11, usuarioId: 4, vendedorId: 8, sedeId: 3, currentStep: 4,
  clienteNombre: null, clienteDocumento: "1062402825", clienteTelefono: null,
  imei: null, plataforma: "IPHONE", payload: { clienteDocumento: "1062402825" },
};

function fixture({ preliminary = baseRow, row = baseRow, blocked = false, synchronizeReads = false } = {}) {
  const events = [];
  const owners = new Map();
  const queues = new Map();
  let transactionId = 0;
  let reads = 0;
  let releaseReads;
  const bothReads = new Promise((resolve) => { releaseReads = resolve; });
  let writes = 0;
  async function acquire(tx, key) {
    events.push([tx.id, key]);
    if (key.startsWith("blacklist:")) {
      assert.equal([...tx.held].some((held) => !held.startsWith("blacklist:")), false,
        "A blacklist lock was acquired after operation/identity/row locks");
    }
    if (owners.get(key) === tx.id) return;
    if (owners.has(key)) {
      await new Promise((resolve) => {
        const waiting = queues.get(key) ?? [];
        waiting.push({ tx, resolve });
        queues.set(key, waiting);
      });
    } else owners.set(key, tx.id);
    tx.held.add(key);
  }
  function release(tx) {
    for (const key of tx.held) {
      const waiting = queues.get(key)?.shift();
      if (waiting) { owners.set(key, waiting.tx.id); waiting.resolve(); }
      else owners.delete(key);
    }
  }
  const prisma = {
    $transaction: async (operation) => {
      const tx = {
        id: ++transactionId, held: new Set(),
        $queryRawUnsafe: async (query) => {
          if (query.includes('AS "blacklistPayloadDocument"')) {
            assert.equal(query.includes("FOR UPDATE"), false);
            events.push([tx.id, "preliminary"]);
            if (synchronizeReads) {
              if (++reads === 2) releaseReads();
              await bothReads;
            }
            return preliminary ? [{ ...preliminary, blacklistPayloadDocument: preliminary.payload?.clienteDocumento }] : [];
          }
          if (query.includes('UPDATE "CreditoBorrador"')) { writes += 1; return [{ id: row.id }]; }
          if (query.includes('FROM "CreditoBorrador"') && query.includes("FOR UPDATE")) {
            await acquire(tx, `row:${row.id}`);
            return [row];
          }
          if (query.includes('FROM "FirmaSeguroProcess"') || query.includes('FROM "VeriffIdentityValidation"')) return [];
          throw new Error(`Unexpected query: ${query}`);
        },
      };
      try { return await operation(tx); } finally { release(tx); }
    },
  };
  const { saveSolicitudDraft } = load(`${sameOwnerSource}\n${saveSource}`, {}, {
    prisma, ...helpers,
    normalizeDigits: (value) => String(value || "").replace(/\D/g, ""),
    normalizePlatform: (value) => value || null,
    normalizeDraftStep: (value, fallback = 1) => value == null ? fallback : Math.max(1, Math.min(5, Number(value))),
    isUuid: (value) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value),
    ensureSolicitudSchema: async () => undefined,
    ensureFirmaSeguroSchema: async () => undefined,
    expireStaleWith: async () => undefined,
    assertDocumentNotBlacklisted: async (document, tx) => {
      await acquire(tx, `blacklist:${document}`);
      if (blocked) throw new core.DocumentBlacklistError("DOCUMENT_BLACKLISTED", "Bloqueado", 403);
    },
    lockSolicitudOperationMutation: (tx, id) => acquire(tx, `operation:${id}`),
    lockIdentity: (tx, kind, value) => acquire(tx, `${kind}:${value}`),
    resolveSolicitudDraftCanonicalIdentity: canonical.resolveSolicitudDraftCanonicalIdentity,
    findActiveByIdentity: async (tx) => { await acquire(tx, `row:${row.id}`); return row; },
    firmaSeguroTermsAreLocked: () => false,
    ActiveSolicitudConflictError: Error,
    SolicitudCanonicalMutationError: canonical.SolicitudCanonicalMutationError,
  });
  return { save: saveSolicitudDraft, events, get writes() { return writes; } };
}

test("autoguardado completo y evidence-only concurrentes toman blacklist antes de operation y terminan", { timeout: 2000 }, async () => {
  const run = fixture({ synchronizeReads: true });
  const evidence = { ...baseInput, clienteDocumento: null, currentStep: 5, payloadScope: "DELIVERY_EVIDENCE", payload: { fotoEntregaDataUrl: "data:image/png;base64,fixture" } };
  const results = await Promise.all([run.save(baseInput), run.save(evidence)]);
  assert.deepEqual(results.map((item) => item.id), [11, 11]);
  assert.equal(run.writes, 2);
  for (const id of [1, 2]) {
    const locks = run.events.filter(([owner]) => owner === id).map(([, key]) => key);
    assert.ok(locks.indexOf("blacklist:1062402825") < locks.indexOf("operation:11"));
    assert.equal(locks.filter((key) => key.startsWith("blacklist:")).length, 1);
  }
});

test("si la identidad cambia entre prelectura y bloqueo de fila falla409 sin tomar lock tardío", async () => {
  const changed = { ...baseRow, clienteDocumento: "9988776655", payload: { ...baseRow.payload, clienteDocumento: "9988776655" } };
  const run = fixture({ row: changed });
  await assert.rejects(() => run.save({ ...baseInput, clienteDocumento: null, payload: {} }),
    (error) => error.code === "DRAFT_IDENTITY_CHANGED" && error.status === 409);
  assert.equal(run.writes, 0);
  assert.equal(run.events.some(([, key]) => key === "blacklist:9988776655"), false);
});

test("evidence-only bloqueado se rechaza antes de cualquier lock de solicitud", async () => {
  const run = fixture({ blocked: true });
  await assert.rejects(() => run.save({ ...baseInput, clienteDocumento: null, payload: {} }),
    (error) => error.code === "DOCUMENT_BLACKLISTED");
  assert.deepEqual(run.events, [[1, "preliminary"], [1, "blacklist:1062402825"]]);
  assert.equal(run.writes, 0);
});

test("no consulta lista negra de un borrador que pertenece a otro vendedor", async () => {
  const run = fixture({ preliminary: { ...baseRow, vendedorId: 99 } });
  await assert.rejects(() => run.save(baseInput), /SOLICITUD_NO_AUTORIZADA/);
  assert.deepEqual(run.events, [[1, "preliminary"]]);
  assert.equal(run.writes, 0);
});

test("la prelectura no reemplaza la autorización bajo bloqueo de fila", async () => {
  const run = fixture({ row: { ...baseRow, vendedorId: 99 } });
  await assert.rejects(() => run.save(baseInput), /SOLICITUD_NO_AUTORIZADA/);
  assert.equal(run.writes, 0);
});

test("una resolución por IMEI no puede introducir otra CC después de bloquear identidad", async () => {
  const run = fixture();
  await assert.rejects(() => run.save({ ...baseInput, id: null, clienteDocumento: null, imei: "355190874496946", payload: {} }),
    (error) => error.code === "DRAFT_IDENTITY_CHANGED" && error.status === 409);
  assert.equal(run.writes, 0);
  assert.equal(run.events.some(([, key]) => key.startsWith("blacklist:")), false);
});

test("cédulas preliminares se normalizan, deduplican y ordenan para tomar locks", () => {
  const documents = helpers.collectSolicitudBlacklistDocuments("9.988.776.655", "001062402825", "1.062.402.825", null, "");
  assert.deepEqual([...documents], ["1062402825", "9988776655"]);
  assert.doesNotThrow(() => helpers.assertSolicitudBlacklistDocumentsLocked(new Set(documents), "001.062.402.825"));
  assert.throws(() => helpers.assertSolicitudBlacklistDocumentsLocked(new Set(documents), "123456789"),
    (error) => error.code === "DRAFT_IDENTITY_CHANGED");
});
