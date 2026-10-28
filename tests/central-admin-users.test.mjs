import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, dependencies = {}, logger = console) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} };
  new Function("require", "module", "exports", "console", outputText)((name) => {
    if (name in dependencies) return dependencies[name];
    assert.ok(name.startsWith("node:"), `Unexpected dependency: ${name}`);
    return require(name);
  }, mod, mod.exports, logger);
  return mod.exports;
}

const password = load("lib/password.ts");
const roles = load("lib/roles.ts");
const central = { id: 1, activo: true, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 10 };
const ally = { ...central, id: 2, aliadoAccesoCodigo: "ALIADO", aliadoAccesoId: 20 };
const valid = { tipoPerfil: "ADMIN_CENTRAL", nombre: "Segundo administrador", usuario: "admin.segundo", clave: "isolated-test-passphrase", confirmarClave: "isolated-test-passphrase" };
const request = (body) => new Request("https://finser.test/api/usuarios/admin", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function fixture(actor = central, options = {}) {
  const created = [];
  const sedeQueries = [];
  const listingQueries = [];
  const logged = [];
  let role;
  const prisma = {
    sede: {
      findFirst: async (query) => {
        sedeQueries.push(query);
        if (options.noCentralSite && query.where.codigo) return null;
        if (query.where.aliadoId === 20 && query.where.id !== 42) return null;
        return { id: query.where.codigo ? 7 : query.where.id };
      },
      findMany: async () => [],
    },
    vendedor: { findMany: async () => [] },
    usuario: {
      findUnique: async () => options.duplicate ? { id: 4 } : null,
      create: async ({ data }) => {
        if (options.raceDuplicate) throw Object.assign(new Error("Duplicate"), { code: "P2002" });
        created.push(data);
        return { id: 8 };
      },
      findMany: async (query) => {
        listingQueries.push(query);
        return created.map((data) => ({ ...data, id: 8, rol: { nombre: "ADMIN" },
          sede: { id: data.sedeId, nombre: "Central", aliado: { id: 10, nombre: "FINSER PAY", codigo: "FINSERPAY" } },
          createdAt: new Date(), updatedAt: new Date(),
        }));
      },
    },
    rol: { upsert: async (query) => { role = query; return { id: 3 }; } },
  };
  const api = load("app/api/usuarios/admin/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/prisma": { default: prisma }, "@/lib/auth": { getSessionUser: async () => actor },
    "@/lib/password": password, "@/lib/seller-auth": {}, "@/lib/roles": roles,
    "@/lib/profile-avatars": { normalizarAvatarPerfil: () => "admin", normalizarTipoPerfilVendedor: () => "VENDEDOR" },
    "@/lib/aliados": { isFinserPayCentralAlly: (value) => value === "FINSERPAY" },
    "@/lib/vendor-profile-schema": { ensureVendorProfileVisualColumns: async () => {
      if (options.failure) throw new Error(options.failure);
    } },
    "@/lib/user-profile-schema": { ensureUserProfileVisualColumns: async () => {} },
    "@/lib/approval-analyst-account-audit": {},
  }, { error: (...args) => logged.push(args) });
  return { api, created, sedeQueries, listingQueries, logged, role: () => role };
}

test("solo una sesión central puede crear Admin Central FINSER", async () => {
  for (const [actor, status] of [[null, 401], [ally, 403], [{ ...central, rolNombre: "ANALISTA_APROBACION" }, 403], [{ ...ally, aliadoAccesoId: null }, 403]]) {
    const f = fixture(actor);
    assert.equal((await f.api.POST(request(valid))).status, status);
    assert.equal(f.created.length, 0);
  }
});

test("el servidor fija rol y sede central, crea login independiente y nunca responde contraseña o hash", async () => {
  const f = fixture();
  const response = await f.api.POST(request({ ...valid, sedeId: 999, rolId: 900, usuario: "ADMIN.SEGUNDO" }));
  assert.equal(response.status, 200);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].usuario, "admin.segundo");
  assert.equal(f.created[0].sedeId, 7);
  assert.equal(f.created[0].rolId, 3);
  assert.equal(f.role().where.nombre, "ADMIN");
  assert.equal(f.sedeQueries[0].where.aliado.codigo, "FINSERPAY");
  assert.equal(f.sedeQueries[0].where.aliado.activo, true);
  assert.equal(f.sedeQueries[0].where.activa, true);
  assert.ok(password.isPasswordHash(f.created[0].claveHash));
  assert.ok(password.verifyPassword(valid.clave, f.created[0].claveHash));
  assert.equal("clave" in f.created[0], false);
  const body = await response.text();
  assert.doesNotMatch(body, /claveHash|scrypt\$|isolated-test-passphrase/);
});

test("valida identidad, longitud y confirmación antes de crear administrador", async () => {
  for (const change of [{ clave: "1234" }, { clave: "a".repeat(129) }, { clave: "        ", confirmarClave: "        " }, { confirmarClave: "distinta" }, { confirmarClave: undefined }, { usuario: "a" }, { usuario: "<admin>" }, { nombre: "" }]) {
    const f = fixture();
    assert.equal((await f.api.POST(request({ ...valid, ...change }))).status, 400);
    assert.equal(f.created.length, 0);
  }
});

test("conserva exactamente la contraseña ingresada, incluidos espacios", async () => {
  const f = fixture();
  const clave = " passphrase with spaces ";
  assert.equal((await f.api.POST(request({ ...valid, clave, confirmarClave: clave }))).status, 200);
  assert.equal(password.verifyPassword(clave, f.created[0].claveHash), true);
  assert.equal(password.verifyPassword(clave.trim(), f.created[0].claveHash), false);
});

test("no reutiliza usuarios ni crea cuentas si falta la sede central", async () => {
  for (const options of [{ duplicate: true }, { raceDuplicate: true }, { noCentralSite: true }]) {
    const f = fixture(central, options);
    assert.equal((await f.api.POST(request(valid))).status, 409);
    assert.equal(f.created.length, 0);
  }
});

test("Admin Aliados mantiene creación en su sede y no puede asignar una sede central", async () => {
  const f = fixture(ally);
  assert.equal((await f.api.POST(request({ ...valid, tipoPerfil: "ADMINISTRADOR", sedeId: 42 }))).status, 200);
  assert.equal(f.created[0].sedeId, 42);
  assert.equal(f.sedeQueries[0].where.aliadoId, 20);
  const denied = fixture(ally);
  assert.equal((await denied.api.POST(request({ ...valid, tipoPerfil: "ADMINISTRADOR", sedeId: 7 }))).status, 400);
  assert.equal(denied.created.length, 0);
});

test("un ADMIN sin aliado no obtiene alcance global ni puede modificar usuarios", async () => {
  const f = fixture({ ...ally, aliadoAccesoId: null });
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.equal((await f.api[method](request(valid))).status, 403);
  }
  assert.equal(f.created.length, 0);
  assert.equal(f.listingQueries.length, 0);
});

test("fallos de persistencia no exponen credenciales ni hashes en logs o respuestas", async () => {
  for (const method of ["POST", "PATCH"]) {
    const f = fixture(central, { failure: "scrypt$secret-hash isolated-test-passphrase" });
    const response = await f.api[method](request(valid));
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /scrypt|secret-hash|isolated-test-passphrase/);
    assert.equal(f.logged.length, 1);
    assert.doesNotMatch(JSON.stringify(f.logged), /scrypt|secret-hash|isolated-test-passphrase/);
  }
});
