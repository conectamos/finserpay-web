import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(file, dependencies = {}) {
  const vmModule = { exports: {} };
  const code = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module: vmModule, exports: vmModule.exports, URL, Request, Response, console,
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  });
  return vmModule.exports;
}

const roles = load("lib/roles.ts");
const aliados = load("lib/aliados.ts");
const central = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
const allyAdmin = { id: 2, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" };
const seller = { id: 3, rolNombre: "VENDEDOR", aliadoAccesoCodigo: "ALIADO" };
const originalItems = [
  { id: 1, marca: "IPHONE", modelo: "iPhone 13", precioBaseVenta: 2_500_000, activo: true },
  { id: 2, marca: "Samsung", modelo: "Galaxy A55", precioBaseVenta: 1_800_000, activo: true },
  { id: 3, marca: "Samsung", modelo: "Galaxy A25", precioBaseVenta: 900_000, activo: false },
];

function fixture(user) {
  let items = structuredClone(originalItems);
  const calls = { reads: [], finds: [], creates: [], updates: [], deletes: [] };
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const catalog = {
    normalizeEquipmentCatalogText: normalize,
    async getEquipmentCatalog(options) {
      calls.reads.push(plain(options));
      return structuredClone(items.filter((item) => options.includeInactive || item.activo));
    },
    async findEquipmentCatalogItem(input) {
      calls.finds.push(plain(input));
      return items.find((item) => item.marca.toUpperCase() === input.marca.toUpperCase() &&
        item.modelo.toUpperCase() === input.modelo.toUpperCase()) || null;
    },
    async createEquipmentCatalogItem(input) {
      calls.creates.push(plain(input));
      const item = { id: Math.max(...items.map((row) => row.id)) + 1, ...input, activo: true };
      items.push(item);
      return structuredClone(item);
    },
    async updateEquipmentCatalogItem(input) {
      calls.updates.push(plain(input));
      const item = items.find((row) => row.id === input.id);
      if (!item) return null;
      Object.assign(item, input, { activo: input.activo ?? item.activo });
      return structuredClone(item);
    },
    async deleteEquipmentCatalogItem(id) {
      calls.deletes.push(id);
      items = items.filter((item) => item.id !== id);
    },
  };
  const route = load("app/api/creditos/catalogo-equipos/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/equipment-catalog": catalog,
    "@/lib/roles": roles,
    "@/lib/aliados": aliados,
  });
  return {
    calls,
    snapshot: () => plain(items),
    async request(method = "GET", body, search = "") {
      const response = await route[method](new Request(`http://localhost/api/creditos/catalogo-equipos${search}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }),
      }));
      return { status: response.status, data: await response.json() };
    },
  };
}

function assertNoWrites(f) {
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.updates, []);
  assert.deepEqual(f.calls.deletes, []);
  assert.deepEqual(f.snapshot(), originalItems);
}

test("el catálogo exige una sesión y no consulta ni modifica datos sin ella", async () => {
  const f = fixture(null);
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const result = await f.request(method, undefined, "?id=1&includeInactive=true");
    assert.equal(result.status, 401, method);
    assert.equal(result.data.error, "No autenticado", method);
  }
  assert.deepEqual(f.calls.reads, []);
  assert.deepEqual(f.calls.finds, []);
  assertNoWrites(f);
});

test("la consulta autenticada conserva los precios reales y muestra únicamente equipos activos", async () => {
  for (const user of [allyAdmin, seller, central]) {
    const f = fixture(user);
    const result = await f.request();
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.items, originalItems.filter((item) => item.activo));
    assert.deepEqual(f.calls.reads, [{ includeInactive: false }]);
    assertNoWrites(f);
  }
});

test("el administrador aliado no obtiene inactivos mediante parámetros de URL", async () => {
  for (const user of [allyAdmin, seller, { ...central, rolNombre: "VENDEDOR" }]) {
    const f = fixture(user);
    const result = await f.request("GET", undefined, "?includeInactive=true");
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.items, originalItems.filter((item) => item.activo));
    assert.deepEqual(f.calls.reads, [{ includeInactive: false }]);
    assertNoWrites(f);
  }
});

test("solo el administrador central puede solicitar los modelos inactivos", async () => {
  const f = fixture(central);
  const result = await f.request("GET", undefined, "?includeInactive=true");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.items, originalItems);
  assert.deepEqual(f.calls.reads, [{ includeInactive: true }]);
  assertNoWrites(f);
});

test("aliados y otros perfiles no pueden crear, cambiar precios ni eliminar equipos por API", async () => {
  for (const user of [allyAdmin, seller, { ...central, rolNombre: "VENDEDOR" }, { ...central, aliadoAccesoCodigo: null }]) {
    const f = fixture(user);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const result = await f.request(method, method === "DELETE" ? undefined : {
        id: 1, marca: "IPHONE", modelo: "iPhone 13", precioBaseVenta: "1", activo: false,
      }, "?id=1");
      assert.equal(result.status, 403, `${user.rolNombre}/${user.aliadoAccesoCodigo}/${method}`);
      assert.match(result.data.error, /administrador central/);
    }
    assert.deepEqual(f.calls.reads, []);
    assert.deepEqual(f.calls.finds, []);
    assertNoWrites(f);
  }
});

test("el administrador central conserva creación, normalización y rechazo de duplicados", async () => {
  const f = fixture(central);
  const body = { marca: "  Motorola ", modelo: " Moto   G85 ", precioBaseVenta: "$ 1.450.000" };
  const result = await f.request("POST", body);
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.creates, [{ marca: "Motorola", modelo: "Moto G85", precioBaseVenta: 1_450_000 }]);
  assert.deepEqual(result.data.items.at(-1), { id: 4, marca: "Motorola", modelo: "Moto G85", precioBaseVenta: 1_450_000, activo: true });
  assert.ok(result.data.items.some((item) => !item.activo), "La consola central conserva la lista completa");
  assert.deepEqual(f.calls.reads, [{ includeInactive: true }]);
  const duplicate = await f.request("POST", body);
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.data.error, /ya existe/);
  assert.equal(f.calls.creates.length, 1);
});

test("el administrador central conserva edición de precio, inactivación y eliminación", async () => {
  const f = fixture(central);
  const updated = await f.request("PATCH", { id: 2, marca: "Samsung", modelo: "Galaxy A55", precioBaseVenta: "$ 1.700.000", activo: false });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.items.find((item) => item.id === 2), { id: 2, marca: "Samsung", modelo: "Galaxy A55", precioBaseVenta: 1_700_000, activo: false });
  assert.equal(f.calls.updates.length, 1);
  const deleted = await f.request("DELETE", undefined, "?id=2");
  assert.equal(deleted.status, 200);
  assert.deepEqual(f.calls.deletes, [2]);
  assert.equal(deleted.data.items.some((item) => item.id === 2), false);
  assert.deepEqual(f.calls.reads, [{ includeInactive: true }, { includeInactive: true }]);
});

test("se conservan las validaciones de gestión central y no escriben entradas inválidas", async () => {
  const f = fixture(central);
  for (const body of [
    { marca: "", modelo: "Modelo", precioBaseVenta: 1 },
    { marca: "Samsung", modelo: "", precioBaseVenta: 1 },
    { marca: "Samsung", modelo: "Modelo", precioBaseVenta: 0 },
  ]) assert.equal((await f.request("POST", body)).status, 400);
  for (const body of [
    { id: 0, marca: "Samsung", modelo: "Modelo", precioBaseVenta: 1 },
    { id: 1, marca: "Samsung", modelo: "", precioBaseVenta: 1 },
    { id: 1, marca: "Samsung", modelo: "Modelo", precioBaseVenta: 0 },
  ]) assert.equal((await f.request("PATCH", body)).status, 400);
  for (const search of ["", "?id=0", "?id=1.5", "?id=abc"]) {
    assert.equal((await f.request("DELETE", undefined, search)).status, 400);
  }
  assertNoWrites(f);
});
