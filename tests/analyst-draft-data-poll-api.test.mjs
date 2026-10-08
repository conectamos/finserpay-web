import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { isDirectSalesProfile } from "../lib/solicitud-operation-access.ts";

const source = readFileSync(new URL("../app/api/creditos/borradores/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const db = new PGlite();
await db.exec(`
  CREATE TABLE "Sede" ("id" integer PRIMARY KEY, "aliadoId" integer);
  CREATE TABLE "CreditoBorrador" (
    "id" integer PRIMARY KEY, "estado" text, "vendedorId" integer, "sedeId" integer,
    "clienteDocumento" text, "creditoId" integer, "createdAt" timestamptz DEFAULT NOW(),
    "expiresAt" timestamptz DEFAULT NOW() + INTERVAL '15 days', "payload" jsonb
  );
  INSERT INTO "Sede" VALUES (1,7),(2,8);
`);
const correction = {
  analystDataRevision: 1,
  analystDataCorrection: { revision: 1, fields: ["clienteTelefono"],
    values: { clienteTelefono: "3000000001" }, fieldRevisions: { clienteTelefono: 1 } },
  analystFinancialRevision: 2,
  analystFinancialCorrection: { revision: 2, fields: ["valorEquipoTotal", "cuotaInicial", "plazoMeses"],
    values: { valorEquipoTotal: "4000000", cuotaInicial: "1200000", plazoMeses: "40" },
    fieldRevisions: { valorEquipoTotal: 2, cuotaInicial: 2, plazoMeses: 2 } },
  analystEvidenceRevision: 3,
  analystEvidenceCorrection: { revision: 3, fields: ["fotoRemisionDataUrl"],
    fieldRevisions: { fotoRemisionDataUrl: 3 }, updatedAt: "2030-01-01T10:00:00.000Z" },
  fotoRemisionDataUrl: `data:image/jpeg;base64,${"X".repeat(1_000_000)}`,
  valorEquipoTotal: "5000000",
};
for (const [id, sellerId, sedeId, state, linked, expired, document] of [
  [11,80,1,"ABIERTO",null,false,"111111"],
  [12,81,1,"ABIERTO",null,false,"222222"],
  [13,80,2,"ABIERTO",null,false,"333333"],
  [14,80,1,"ABIERTO",null,true,"444444"],
  [15,80,1,"CERRADO",null,false,"555555"],
  [16,80,1,"ABIERTO",99,false,"666666"],
  [17,80,1,"ABIERTO",null,false,"bloqueado"],
]) {
  await db.query(`INSERT INTO "CreditoBorrador"
    ("id","vendedorId","sedeId","estado","creditoId","expiresAt","clienteDocumento","payload")
    VALUES ($1,$2,$3,$4,$5,NOW() + ($6::integer * INTERVAL '1 day'),$7,$8::jsonb)`,
    [id,sellerId,sedeId,state,linked,expired ? -1 : 15,document,JSON.stringify(correction)]);
}
after(() => db.close());

function fixture({ user = { id: 4, rolNombre: "VENDEDOR", aliadoId: 7 },
  seller = { id: 80, tipoPerfil: "VENDEDOR" } } = {}) {
  const queries = [];
  const blacklistDocuments = [];
  let globalMaintenance = 0;
  const dependencies = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async (document) => {
      blacklistDocuments.push(document);
      if (document === "bloqueado") throw Object.assign(new Error("bloqueado"), { blacklist: true });
    } },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: (error) =>
      error.blacklist ? Response.json({ error: "bloqueado" }, { status: 403 }) : null },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": { isFinserPayCentralAlly: (code) => code === "FINSERPAY" },
    "@/lib/credit-factory": { sanitizeSearch: (value) => String(value || "").trim(), sanitizeText: (value) => String(value || "").trim() },
    "@/lib/credit-client-name": { composeCreditClientName: () => "" },
    "@/lib/prisma": { default: { $queryRawUnsafe: async (query, ...values) => {
      queries.push(query);
      return (await db.query(query, values)).rows;
    } } },
    "@/lib/roles": { isAdminRole: (role) => role === "ADMIN" },
    "@/lib/seller-auth": { getSellerSessionUser: async () => seller },
    "@/lib/solicitud-operation-access": { isDirectSalesProfile, canOperateSolicitud: () => false },
    "@/lib/solicitudes": { SolicitudCanonicalMutationError: class extends Error {} },
    "@/lib/firmaseguro-status": { isFirmaSeguroSuccessfulStatus: () => false },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => { globalMaintenance++; } },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => { globalMaintenance++; } },
    "@/lib/solicitudes-storage": {
      ActiveSolicitudConflictError: class extends Error {},
      expireStaleSolicitudes: async () => { globalMaintenance++; },
    },
  };
  const loadedModule = { exports: {} };
  runInNewContext(compiled, { module: loadedModule, exports: loadedModule.exports, URL, Buffer, console,
    require: (name) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return { route: loadedModule.exports, queries, blacklistDocuments, getMaintenance: () => globalMaintenance };
}
const request = (id) => new Request(`https://finser.test/api/creditos/borradores?id=${id}&datosAnalista=1`);

test("el asesor titular recibe revisiones y valores financieros corregidos en SQL, sin fotos ni expediente completo", async () => {
  const f = fixture();
  const response = await f.route.GET(request(11));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, item: { id: 11, payload: {
    analystDataRevision: correction.analystDataRevision,
    analystDataCorrection: correction.analystDataCorrection,
    analystFinancialRevision: correction.analystFinancialRevision,
    analystFinancialCorrection: correction.analystFinancialCorrection,
    analystEvidenceRevision: correction.analystEvidenceRevision,
    analystEvidenceCorrection: correction.analystEvidenceCorrection,
  } } });
  assert.ok(JSON.stringify(body).length < 1_000);
  assert.equal(f.queries.length, 1);
  assert.match(f.queries[0], /jsonb_build_object/);
  assert.doesNotMatch(f.queries[0], /d\."payload"\s*(?:,|AS)/);
  assert.deepEqual(f.blacklistDocuments, ["111111"]);
  assert.equal(f.getMaintenance(), 0, "polling no ejecuta mantenimiento global en cada lectura");
});

test("otro asesor del mismo aliado y el titular de otro aliado no pueden consultar la revisión", async () => {
  for (const id of [12,13]) {
    const f = fixture();
    const response = await f.route.GET(request(id));
    assert.equal(response.status, 404);
    assert.deepEqual(f.blacklistDocuments, []);
  }
});

test("conserva el alcance del administrador aliado y la lectura global central", async () => {
  const ally = fixture({ user: { id: 4, rolNombre: "ADMIN", aliadoAccesoId: 7, aliadoAccesoCodigo: "OTRO" } });
  assert.equal((await ally.route.GET(request(12))).status, 200);
  assert.equal((await ally.route.GET(request(13))).status, 404);
  const central = fixture({ user: { id: 4, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" } });
  assert.equal((await central.route.GET(request(13))).status, 200);
});

test("una solicitud vencida, cerrada o vinculada a crédito no devuelve revisiones", async () => {
  const f = fixture();
  for (const id of [14,15,16]) assert.equal((await f.route.GET(request(id))).status, 404);
});

test("sin sesión o perfil comercial no lee ninguna fila", async () => {
  for (const [user,seller,status] of [
    [null,null,401], [{ id: 4, rolNombre: "ANALISTA_APROBACION" },null,403],
  ]) {
    const f = fixture({ user, seller });
    assert.equal((await f.route.GET(request(11))).status, status);
    assert.equal(f.queries.length, 0);
  }
});

test("la lectura ligera mantiene la lista negra y exige un identificador válido", async () => {
  const f = fixture();
  assert.equal((await f.route.GET(request(17))).status, 403);
  assert.equal((await f.route.GET(request("invalido"))).status, 400);
  assert.equal(f.queries.length, 1);
});
