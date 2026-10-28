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
  return { api, prisma, created, sedeQueries, listingQueries, logged, role: () => role };
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

const initialUpdatedAt = "2026-10-28T12:00:00.000Z";
const validEdit = {
  tipoPerfil: "ADMIN_CENTRAL", administradorId: 3,
  nombre: "Administrador actualizado", usuario: "central.actualizado", activo: true,
  expectedUpdatedAt: initialUpdatedAt,
};
const editRequest = (body = validEdit, headers = {}) => new Request("https://finser.test/api/usuarios/admin", {
  method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://finser.test", ...headers },
  body: JSON.stringify(body),
});

function managementStore() {
  const account = (id, changes = {}) => ({
    id, nombre: `Administrador ${id}`, usuario: `central.${id}`, activo: true,
    avatarKey: "admin", claveHash: "scrypt$private-password-hash", legacySessionRevokedAt: null,
    sedeId: 7, rolId: 3, createdAt: new Date(initialUpdatedAt), updatedAt: new Date(initialUpdatedAt),
    rol: { nombre: "ADMIN" },
    sede: { id: 7, nombre: "Central", activa: true, aliado: { id: 10, nombre: "FINSER PAY", codigo: "FINSERPAY", activo: true } },
    ...changes,
  });
  return { revision: 0, accounts: [account(1), account(3), account(5, { activo: false }),
    account(2, { usuario: "aliado.existing", sede: { id: 42, activa: true, aliado: { id: 20, codigo: "ALIADO", activo: true } } }),
    account(4, { usuario: "analista.existing", rol: { nombre: "ANALISTA_APROBACION" } }),
  ] };
}

function managementFixture(actor = central, options = {}, store = managementStore()) {
  const f = fixture(actor);
  const transactions = [];
  const updates = [];
  const matches = (row, where) => {
    if (where.id !== undefined && (typeof where.id === "object" ? row.id === where.id.not : row.id !== where.id)) return false;
    if (where.activo !== undefined && row.activo !== where.activo) return false;
    if (where.usuario !== undefined && row.usuario !== where.usuario) return false;
    if (where.updatedAt && row.updatedAt.getTime() !== where.updatedAt.getTime()) return false;
    if (where.rol && row.rol.nombre !== where.rol.nombre) return false;
    if (where.sede) {
      if (row.sede?.activa !== where.sede.activa || row.sede?.aliado?.codigo !== where.sede.aliado.codigo || row.sede?.aliado?.activo !== where.sede.aliado.activo) return false;
    }
    return true;
  };
  f.prisma.usuario.findMany = async () => structuredClone(store.accounts);
  f.prisma.$transaction = async (callback, transactionOptions) => {
    transactions.push(transactionOptions);
    const rows = structuredClone(store.accounts);
    const revision = store.revision;
    let changed = false;
    const result = await callback({ usuario: {
      findFirst: async ({ where }) => rows.find((row) => matches(row, where)) ?? null,
      count: async ({ where }) => options.activeCount ?? rows.filter((row) => matches(row, where)).length,
      updateMany: async (query) => {
        updates.push(query);
        if (options.writeError) throw Object.assign(new Error("scrypt$private-password-hash"), { code: options.writeError });
        if (options.casConflict) return { count: 0 };
        const matching = rows.filter((row) => matches(row, query.where));
        for (const row of matching) Object.assign(row, query.data);
        changed = matching.length > 0;
        return { count: matching.length };
      },
    } });
    // Model PostgreSQL rejecting concurrent writes that invalidate a serializable
    // snapshot. Without that isolation, the opposing deactivations both commit.
    if (changed && transactionOptions?.isolationLevel === "Serializable" && store.revision !== revision) {
      throw Object.assign(new Error("serialization conflict"), { code: "P2034" });
    }
    if (changed) {
      // Merge only written rows to model write skew under weaker isolation.
      for (const query of updates.slice(-1)) {
        const row = store.accounts.find((item) => item.id === query.where.id);
        Object.assign(row, query.data);
      }
      store.revision++;
    }
    return result;
  };
  return { ...f, store, transactions, updates };
}

test("edita identidad central con CAS sin modificar rol, sede, clave o revocación de sesiones", async () => {
  const f = managementFixture();
  const original = structuredClone(f.store.accounts.find((row) => row.id === 3));
  const response = await f.api.PATCH(editRequest({ ...validEdit, nombre: "  Nuevo   nombre ", usuario: "CENTRAL.NUEVO" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const current = f.store.accounts.find((row) => row.id === 3);
  assert.equal(current.nombre, "Nuevo nombre");
  assert.equal(current.usuario, "central.nuevo");
  for (const key of ["rolId", "sedeId", "claveHash", "legacySessionRevokedAt"]) assert.deepEqual(current[key], original[key]);
  assert.ok(current.updatedAt > original.updatedAt);
  assert.equal(f.transactions[0].isolationLevel, "Serializable");
  assert.deepEqual(Object.keys(f.updates[0].data).sort(), ["activo", "nombre", "updatedAt", "usuario"]);
  const body = await response.json();
  assert.ok(body.administradores.find((row) => row.id === 3 && row.usuario === "central.nuevo"));
  assert.doesNotMatch(JSON.stringify(body), /claveHash|scrypt\$|legacySessionRevokedAt/);
});

test("GET muestra centrales activos e inactivos sin credenciales y conserva alcance del aliado", async () => {
  const f = managementFixture();
  const response = await f.api.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.administradores.find((row) => row.id === 1 && row.activo));
  assert.ok(body.administradores.find((row) => row.id === 5 && !row.activo));
  assert.doesNotMatch(JSON.stringify(body), /claveHash|scrypt\$|legacySessionRevokedAt/);
  const scoped = fixture(ally);
  assert.equal((await scoped.api.GET()).status, 200);
  assert.equal(scoped.listingQueries[0].where.sede.aliadoId, ally.aliadoAccesoId);
  assert.equal(scoped.listingQueries[0].select.claveHash, undefined);
});

test("solo central puede editar centrales; revalida actor, rol, sede y aliado al escribir", async () => {
  for (const [actor, status] of [[null, 401], [ally, 403], [{ ...central, rolNombre: "ANALISTA_APROBACION" }, 403], [{ ...central, activo: false }, 403]]) {
    const f = managementFixture(actor);
    assert.equal((await f.api.PATCH(editRequest())).status, status);
    assert.equal(f.updates.length, 0);
  }
  for (const mutation of [(row) => { row.activo = false; }, (row) => { row.rol.nombre = "VENDEDOR"; },
    (row) => { row.sede.activa = false; }, (row) => { row.sede.aliado.activo = false; }, (row) => { row.sede.aliado.codigo = "ALIADO"; }]) {
    const f = managementFixture();
    mutation(f.store.accounts.find((row) => row.id === 1));
    assert.equal((await f.api.PATCH(editRequest())).status, 403);
    assert.equal(f.updates.length, 0);
  }
  for (const id of [2, 4, 999]) {
    const f = managementFixture();
    assert.equal((await f.api.PATCH(editRequest({ ...validEdit, administradorId: id }))).status, 404);
    assert.equal(f.updates.length, 0);
  }
});

test("rechaza cambios de privilegios, credenciales y cuerpos inválidos antes de escribir", async () => {
  for (const field of ["clave", "claveHash", "password", "pin", "rolId", "rol", "sedeId", "sedeIds", "aliadoId", "analistaId", "vendedorId", "avatarKey"]) {
    const f = managementFixture();
    assert.equal((await f.api.PATCH(editRequest({ ...validEdit, [field]: "untrusted" }))).status, 400, field);
    assert.equal(f.transactions.length, 0);
  }
  for (const change of [{ nombre: "" }, { nombre: "x".repeat(121) }, { nombre: {} }, { usuario: "x" }, { usuario: "<admin>" },
    { usuario: "x".repeat(81) }, { activo: "false" }, { administradorId: "3" }, { administradorId: -1 },
    { expectedUpdatedAt: "invalid" }, { expectedUpdatedAt: undefined }, { tipoPerfil: "ADMINISTRADOR" }]) {
    const f = managementFixture();
    assert.equal((await f.api.PATCH(editRequest({ ...validEdit, ...change }))).status, 400);
    assert.equal(f.transactions.length, 0);
  }
  for (const body of [null, [], "bad body", { ...validEdit, nombre: "x".repeat(65536) }]) {
    const f = managementFixture();
    assert.equal((await f.api.PATCH(editRequest(body))).status, 400);
    assert.equal(f.transactions.length, 0);
  }
  const malformed = new Request("https://finser.test/api/usuarios/admin", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal((await managementFixture().api.PATCH(malformed)).status, 400);
});

test("protege origen y formato de edición central, incluyendo TLS detrás de Railway", async () => {
  for (const headers of [{ Origin: "https://attacker.test" }, { Origin: "null" }, { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" }, { Origin: "https://finser.test/path" }]) {
    const f = managementFixture();
    assert.equal((await f.api.PATCH(editRequest(validEdit, headers))).status, 403);
    assert.equal(f.transactions.length, 0);
  }
  const f = managementFixture();
  assert.equal((await f.api.PATCH(editRequest(validEdit, { "Content-Type": "text/plain" }))).status, 415);
  const proxied = new Request("http://internal:3000/api/usuarios/admin", {
    method: "PATCH", headers: { Origin: "https://finser.test", Host: "finser.test", "Content-Type": "application/json" }, body: JSON.stringify(validEdit),
  });
  assert.equal((await f.api.PATCH(proxied)).status, 200);
});

test("permite activar/desactivar otra cuenta y editar la propia sin permitir autodesactivación", async () => {
  const f = managementFixture();
  assert.equal((await f.api.PATCH(editRequest({ ...validEdit, activo: false }))).status, 200);
  const account = f.store.accounts.find((row) => row.id === 3);
  assert.equal(account.activo, false);
  assert.equal((await f.api.PATCH(editRequest({ ...validEdit, expectedUpdatedAt: account.updatedAt.toISOString() }))).status, 200);
  assert.equal(account.activo, true);
  assert.equal((await f.api.PATCH(editRequest({ ...validEdit, administradorId: 1, usuario: "central.self" }))).status, 200);
  assert.equal((await f.api.PATCH(editRequest({ ...validEdit, administradorId: 1, activo: false }))).status, 403);
  const last = managementFixture(central, { activeCount: 1 });
  assert.equal((await last.api.PATCH(editRequest({ ...validEdit, activo: false }))).status, 409);
  assert.equal(last.updates.length, 0);
});

test("rechaza duplicados, versión obsoleta y carreras de persistencia sin exponer errores privados", async () => {
  for (const change of [{ usuario: "aliado.existing" }, { usuario: "analista.existing" }, { expectedUpdatedAt: "2026-10-27T12:00:00.000Z" }]) {
    const f = managementFixture();
    assert.equal((await f.api.PATCH(editRequest({ ...validEdit, ...change }))).status, 409);
    assert.equal(f.updates.length, 0);
  }
  for (const options of [{ casConflict: true }, { writeError: "P2002" }, { writeError: "P2034" }, { writeError: "UNKNOWN" }]) {
    const f = managementFixture(central, options);
    const response = await f.api.PATCH(editRequest());
    assert.equal(response.status, options.writeError === "UNKNOWN" ? 500 : 409);
    assert.equal(f.store.accounts.find((row) => row.id === 3).usuario, "central.3");
    assert.doesNotMatch(await response.text(), /scrypt|private-password/);
    assert.doesNotMatch(JSON.stringify(f.logged), /scrypt|private-password/);
  }
});

test("desactivaciones simultáneas contrapuestas dejan un central activo y devuelven conflicto", async () => {
  const store = managementStore();
  const first = managementFixture(central, {}, store);
  const second = managementFixture({ ...central, id: 3 }, {}, store);
  const responses = await Promise.all([
    first.api.PATCH(editRequest({ ...validEdit, activo: false })),
    second.api.PATCH(editRequest({ ...validEdit, administradorId: 1, usuario: "central.1", activo: false })),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(store.accounts.filter((row) => [1, 3].includes(row.id) && row.activo).length, 1);
});
