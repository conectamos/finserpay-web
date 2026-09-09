import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { core, store, loadBlacklistModule } from "./document-blacklist-test-loader.mjs";

test("cedulas equivalentes usan una identidad global; letras, vacios y tipos ambiguos se rechazan", () => {
  for (const value of ["1062402825", "1.062.402.825", " 001-062 402 825 "]) assert.equal(core.normalizeBlacklistedDocument(value), "1062402825");
  for (const value of ["", null, 1062402825, "1e9", "123/45", "1_234", "abc123", "0000", "12", "12345678901234"]) {
    assert.throws(() => core.normalizeBlacklistedDocument(value), { code: "INVALID_DOCUMENT", status: 400 });
  }
});

test("parser exige motivo, UUID, estado booleano y version; el cliente no puede sustituir la identidad PATCH", () => {
  assert.throws(() => store.parseBlacklistMutation("POST", { documento: "123456", motivo: "no", mutationId: randomUUID() }), { code: "INVALID_REASON" });
  assert.throws(() => store.parseBlacklistMutation("PATCH", { id: randomUUID(), motivo: "Motivo nuevo", activa: "false", mutationId: randomUUID(), version: 1 }), { code: "INVALID_STATE" });
  const parsed = store.parseBlacklistMutation("PATCH", { id: randomUUID(), motivo: "Cambio prueba", activa: false, mutationId: randomUUID(), version: 2, documento: "666666" });
  assert.equal("documento" in parsed, false);
  assert.throws(() => core.blacklistUuid("bad"), { code: "INVALID_REQUEST_ID" });
  for (const version of [undefined, "1", 0, -1, 1.5]) assert.throws(() => core.blacklistVersion(version), { code: "INVALID_VERSION" });
});

test("guardia global consulta parametros, bloquea sin revelar motivo y falla cerrada si almacenamiento no responde", async () => {
  const events = [];
  const db = {
    $executeRawUnsafe: async (sql, key) => { events.push([sql, key]); return 1; },
    $queryRawUnsafe: async (sql, doc) => { assert.equal(doc, "123456"); events.push([sql, doc]); return [{ activa: true, motivo: "PRIVADO" }]; },
  };
  await assert.rejects(store.assertDocumentAllowed("000123.456", db, true), (error) => {
    assert.equal(error.code, "DOCUMENT_BLACKLISTED");
    assert.equal(error.status, 403);
    assert.equal(error.message.includes("PRIVADO"), false);
    return true;
  });
  assert.match(events[0][0], /pg_advisory_xact_lock/);
  assert.equal(events[0][1], "DOCUMENT_BLACKLIST:123456");
  await assert.rejects(store.assertDocumentAllowed("123456", { $queryRawUnsafe: async () => { throw new Error("database password private"); } }), (error) => {
    assert.equal(error.code, "DOCUMENT_BLACKLIST_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(error.message.includes("password"), false);
    return true;
  });
  await store.assertDocumentAllowed("123456", { $queryRawUnsafe: async () => [] });
  await store.assertDocumentAllowed("123456", { $queryRawUnsafe: async () => [{ activa: false }] });
});

test("API GET POST PATCH niega aliados, vendedores y anonimos antes de leer o escribir motivos", async () => {
  for (const user of [null, { rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" }, { rolNombre: "VENDEDOR", aliadoAccesoCodigo: "FINSERPAY" }, { rolNombre: "ADMIN", aliadoAccesoCodigo: null }]) {
    const access = loadBlacklistModule("lib/datacredito/admin-access.ts", {
      "server-only": {},
      "@/lib/aliados": { isFinserPayCentralAlly: (code) => String(code || "").trim().toUpperCase() === "FINSERPAY" },
      "@/lib/roles": loadBlacklistModule("lib/roles.ts"),
      "@/lib/auth": { getSessionUser: async () => user },
    });
    const nextResponse = { NextResponse: { json: (body, opts) => Response.json(body, opts) } };
    const route = loadBlacklistModule("app/api/lista-negra/route.ts", {
      "next/server": nextResponse,
      "@/lib/datacredito/admin-access": access,
      "@/lib/document-blacklist-core": core,
      "@/lib/document-blacklist-response": loadBlacklistModule("lib/document-blacklist-response.ts", { "next/server": nextResponse, "@/lib/document-blacklist-core": core }),
      "@/lib/document-blacklist-store": { ...store, listBlacklist: () => assert.fail("Private rows accessed"), mutateBlacklist: () => assert.fail("Private rows mutated") },
      "@/lib/prisma": { default: { $transaction: () => assert.fail("Transaction opened") } },
    });
    for (const method of ["GET", "POST", "PATCH"]) {
      const response = await route[method](new Request("https://finser.test/api/lista-negra", { method }));
      assert.equal(response.status, user ? 403 : 401);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal((await response.json()).code, "FORBIDDEN");
    }
  }
});

test("filtros solo permiten cedula y estados conocidos; paginacion es acotada", () => {
  assert.equal(store.parseBlacklistFilters(new URLSearchParams("q=001.234&estado=TODAS&page=2")).q, "1234");
  for (const raw of ["q=%25", "estado=ELIMINADA", "page=-1", "page=1.5", "page=999999999", "q=123456789012345"]) assert.throws(() => store.parseBlacklistFilters(new URLSearchParams(raw)));
});

test("API central valida entrada, normaliza CC y obtiene responsable de la sesion, nunca del body", async () => {
  const actor = { id: 17, nombre: "Admin sintético", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
  const writes = [];
  const nextResponse = { NextResponse: { json: (body, opts) => Response.json(body, opts) } };
  const access = loadBlacklistModule("lib/datacredito/admin-access.ts", {
    "server-only": {},
    "@/lib/aliados": { isFinserPayCentralAlly: (code) => code === "FINSERPAY" },
    "@/lib/roles": loadBlacklistModule("lib/roles.ts"),
    "@/lib/auth": { getSessionUser: async () => actor },
  });
  const transaction = {};
  const route = loadBlacklistModule("app/api/lista-negra/route.ts", {
    "next/server": nextResponse,
    "@/lib/datacredito/admin-access": access,
    "@/lib/document-blacklist-core": core,
    "@/lib/document-blacklist-response": loadBlacklistModule("lib/document-blacklist-response.ts", { "next/server": nextResponse, "@/lib/document-blacklist-core": core }),
    "@/lib/document-blacklist-store": {
      ...store,
      listBlacklist: async (_db, filters) => ({ items: [], total: 0, page: filters.page, pageSize: 25 }),
      mutateBlacklist: async (tx, input, user) => { assert.equal(tx, transaction); writes.push({ input, user }); return { item: { id: randomUUID(), ...input }, idempotent: false }; },
    },
    "@/lib/prisma": { default: { $transaction: async (fn) => fn(transaction) } },
  });
  const post = (body) => new Request("https://finser.test/api/lista-negra", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await route.GET(new Request("https://finser.test/api/lista-negra?estado=TODAS&page=2"))).status, 200);
  const mutationId = randomUUID();
  assert.equal((await route.POST(post({ documento: "001.234.567", motivo: "Bloqueo de prueba", mutationId, actorUserId: 99, createdByName: "Intruso" }))).status, 200);
  assert.equal(writes[0].input.documento, "1234567");
  assert.equal(writes[0].user, actor);
  assert.equal("actorUserId" in writes[0].input, false);
  assert.equal((await route.POST(post({ documento: "1234567", motivo: "No", mutationId }))).status, 400);
  assert.equal(writes.length, 1);
});
