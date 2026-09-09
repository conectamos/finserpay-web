import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadModule(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    exports: loadedModule.exports,
    module: loadedModule,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    console,
    URL,
    Date,
  }, { filename: path });
  return loadedModule.exports;
}

const blacklistCore = loadModule("lib/document-blacklist-core.ts");
const financieras = loadModule("lib/ventas-financieras.ts");
const validSale = {
  clienteDocumento: "1.062.402.825",
  serial: "355190874496946",
  servicio: "CONTADO LIBRES",
  descripcion: "Equipo de prueba",
  jalador: "Vendedor",
  cerrador: "Vendedor",
  ingreso1Base: 500000,
};

function fixture({ blockedAt, unavailable = false, user = { id: 1, sedeId: 7, rolNombre: "ASESOR", nombre: "Asesor" } } = {}) {
  const events = [];
  let persisted = null;
  let updated = null;
  const nextResponse = { json: (body, options) => Response.json(body, options) };
  const blacklistResponse = loadModule("lib/document-blacklist-response.ts", {
    "next/server": { NextResponse: nextResponse },
    "@/lib/document-blacklist-core": blacklistCore,
  });
  const inventory = {
    id: 9, imei: validSale.serial, referencia: "Equipo", color: "Negro",
    costo: 200000, estadoActual: "BODEGA", estadoFinanciero: "PAGO", origen: "SEDE",
  };
  const transaction = {
    venta: {
      create: async ({ data }) => {
        events.push("sale:create");
        persisted = data;
        return { id: 23, idVenta: data.idVenta };
      },
      update: async ({ data }) => { events.push("sale:update"); updated = data; },
    },
    movimientoInventario: { create: async () => { events.push("inventory:movement"); } },
    inventarioSede: { update: async () => { events.push("inventory:update"); } },
  };
  const database = {
    inventarioSede: { findFirst: async () => { events.push("inventory:read"); return inventory; } },
    venta: {
      findFirst: async () => null,
      findMany: async () => [{ id: 23, clienteDocumento: "1062402825" }],
      findUnique: async () => ({
        id: 23, idVenta: "VTA-HISTORICA", sedeId: 7, serial: validSale.serial,
        clienteDocumento: "1062402825", inventarioSede: inventory,
      }),
    },
    $transaction: async (operation) => {
      events.push("transaction");
      return operation(transaction);
    },
  };
  const handlers = loadModule("app/api/ventas/route.ts", {
    "next/server": { NextResponse: nextResponse },
    "@/app/generated/prisma/client": { Prisma: { JsonNull: null } },
    "@/lib/prisma": { default: database },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/document-blacklist-core": blacklistCore,
    "@/lib/document-blacklist": {
      assertDocumentNotBlacklisted: async (document, db) => {
        assert.equal(document, "1062402825");
        const phase = db ? "transaction" : "early";
        if (db) assert.equal(db, transaction);
        events.push(`blacklist:${phase}`);
        if (unavailable) throw blacklistCore.blacklistUnavailable();
        if (blockedAt === phase || blockedAt === "always") {
          throw new blacklistCore.DocumentBlacklistError("DOCUMENT_BLACKLISTED", "Cliente bloqueado en lista negra", 403);
        }
      },
    },
    "@/lib/document-blacklist-response": blacklistResponse,
    "@/lib/ventas-financieras": financieras,
    "@/lib/ventas-personal": {
      obtenerCatalogoPersonalVenta: async () => {
        events.push("catalog:read");
        return { financieras: [] };
      },
    },
  });
  const request = (body = validSale, method = "POST") => new Request("https://finser.test/api/ventas", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { handlers, request, events, get persisted() { return persisted; }, get updated() { return updated; } };
}

test("todas las sedes y roles rechazan nuevas ventas del cliente bloqueado antes de inventario", async () => {
  for (const [rolNombre, sedeId] of [["ASESOR", 7], ["ALIADO_ADMIN", 91], ["ADMIN", 1]]) {
    const run = fixture({ blockedAt: "early", user: { id: 1, sedeId, rolNombre } });
    const response = await run.handlers.POST(run.request());
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).code, "DOCUMENT_BLACKLISTED");
    assert.deepEqual(run.events, ["blacklist:early"]);
    assert.equal(run.persisted, null);
  }
});

test("un bloqueo activado durante la venta impide guardarla y mover inventario", async () => {
  const run = fixture({ blockedAt: "transaction" });
  const response = await run.handlers.POST(run.request());
  assert.equal(response.status, 403);
  assert.deepEqual(run.events, ["blacklist:early", "catalog:read", "inventory:read", "transaction", "blacklist:transaction"]);
  assert.equal(run.persisted, null);
});

test("venta permitida guarda la cedula canonica tras revalidar en su transaccion", async () => {
  const run = fixture();
  const response = await run.handlers.POST(run.request({ ...validSale, clienteDocumento: "001.062.402.825" }));
  assert.equal(response.status, 200);
  assert.equal(run.persisted.clienteDocumento, "1062402825");
  assert.deepEqual(run.events, [
    "blacklist:early", "catalog:read", "inventory:read", "transaction", "blacklist:transaction",
    "sale:create", "inventory:movement", "inventory:update",
  ]);
});

test("omitir o adulterar la cedula no permite evadir la validacion", async () => {
  for (const clienteDocumento of [undefined, null, "", "abc", "1062402825x", {}, 1062402825]) {
    const run = fixture();
    const response = await run.handlers.POST(run.request({ ...validSale, clienteDocumento }));
    assert.equal(response.status, 400, `document=${JSON.stringify(clienteDocumento)}`);
    assert.deepEqual(run.events, []);
    assert.equal(run.persisted, null);
  }
});

test("una solicitud sin sesion no puede consultar el bloqueo ni registrar venta", async () => {
  const run = fixture({ user: null });
  const response = await run.handlers.POST(run.request());
  assert.equal(response.status, 401);
  assert.deepEqual(run.events, []);
});

test("si no se puede verificar la lista no registra ventas ni mueve inventario", async () => {
  const run = fixture({ unavailable: true });
  const response = await run.handlers.POST(run.request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DOCUMENT_BLACKLIST_UNAVAILABLE");
  assert.deepEqual(run.events, ["blacklist:early"]);
  assert.equal(run.persisted, null);
});

test("el historial de ventas sigue siendo consultable tras bloquear al cliente", async () => {
  const run = fixture({ blockedAt: "always" });
  const response = await run.handlers.GET(new Request("https://finser.test/api/ventas"));
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].id, 23);
  assert.deepEqual(run.events, []);
});

test("la edicion administrativa historica no cambia la identidad ni crea otra venta", async () => {
  const run = fixture({ blockedAt: "always", user: { id: 1, sedeId: 7, rolNombre: "ADMIN", nombre: "Admin" } });
  const response = await run.handlers.PUT(run.request({ ...validSale, id: 23 }, "PUT"));
  assert.equal(response.status, 200);
  assert.equal(run.persisted, null);
  assert.equal("clienteDocumento" in run.updated, false);
  assert.deepEqual(run.events, ["catalog:read", "transaction", "sale:update", "inventory:movement"]);
});
