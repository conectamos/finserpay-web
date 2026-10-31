import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { NextResponse } from "next/server.js";
import ts from "typescript";

// Every identity, secret and password in this fixture is synthetic and local.
// Authentication, hashing, signing and the HTTP handlers are the real modules;
// only request cookies, persistence and bootstrap side effects are substituted.
const TEST_SECRET = "isolated-admin-revocation-test-secret-32-characters";
const OLD_PASSWORD = "isolated-old-passphrase-2026";
const NEW_PASSWORD = "isolated-new-passphrase-2026";
const SOURCE = new Map();

function harness({ central = true } = {}) {
  let now = Date.parse("2026-10-28T15:00:00.000Z");
  let activeToken;
  let failSigning = false;
  let failCompareAndSwap = false;
  let beforeLegacyUpgrade;
  const writes = [];
  const legacyUpgradeWrites = [];
  const logs = [];
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function load(path, dependencies = {}) {
    if (!SOURCE.has(path)) SOURCE.set(path, ts.transpileModule(
      readFileSync(new URL("../" + path, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText);
    const loadedModule = { exports: {} };
    runInNewContext(SOURCE.get(path), {
      module: loadedModule, exports: loadedModule.exports, Buffer, URL, Request, Response, Date: FixtureDate,
      process: { env: { NODE_ENV: "production", SESSION_SECRET: TEST_SECRET } },
      console: { error: (...args) => logs.push(args.join(" ")) },
      require(name) {
        if (name === "node:crypto") return crypto;
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${path}: ${name}`);
        return dependencies[name];
      },
    }, { filename: path });
    return loadedModule.exports;
  }
  const session = load("lib/session.ts");
  const password = load("lib/password.ts");
  const roles = load("lib/roles.ts");
  const initialHash = password.hashPassword(OLD_PASSWORD);
  function account(id, isCentral) {
    const siteId = isCentral ? 1 : 2;
    return {
      id, nombre: `Administrador de prueba ${id}`, usuario: `isolated.admin.${id}`, activo: true,
      claveHash: initialHash, legacySessionRevokedAt: null, updatedAt: new Date(now),
      sedeId: siteId, rolId: 1, rol: { id: 1, nombre: "ADMIN", descripcion: "Administrador" },
      sede: { id: siteId, nombre: isCentral ? "Central" : "Aliado", activa: true, aliadoId: siteId,
        aliado: { id: siteId, nombre: isCentral ? "Finser" : "Aliado de prueba",
          codigo: isCentral ? "FINSERPAY" : "ISOLATED_ALLY", activo: true } },
    };
  }
  const user = account(82, central);
  const other = account(83, !central);
  const records = new Map([[user.id, user], [other.id, other]]);
  const prisma = { usuario: {
    async findUnique({ where }) {
      const record = where.id === undefined
        ? [...records.values()].find(value => value.usuario === where.usuario)
        : records.get(where.id);
      return record ? structuredClone(record) : null;
    },
    async updateMany({ where, data }) {
      writes.push({ where, data });
      if (failCompareAndSwap) return { count: 0 };
      const record = records.get(where.id);
      if (!record || Object.entries(where).some(([key, value]) => record[key] !== value)) return { count: 0 };
      Object.assign(record, structuredClone(data), { updatedAt: new Date(now) });
      return { count: 1 };
    },
    async updateManyAndReturn({ where, data }) {
      if (beforeLegacyUpgrade) await beforeLegacyUpgrade();
      legacyUpgradeWrites.push({ where, data });
      const record = records.get(where.id);
      if (!record || Object.entries(where).some(([key, value]) => record[key] !== value)) return [];
      Object.assign(record, structuredClone(data), { updatedAt: new Date(now) });
      return [{ updatedAt: record.updatedAt }];
    },
    async update() { assert.fail("Synthetic fixture uses hashed passwords; login must not rewrite them"); },
  } };
  const auth = load("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ get: name => name === session.SESSION_COOKIE_NAME && activeToken
      ? { value: activeToken } : undefined }) },
    "@/lib/prisma": { default: prisma }, "@/lib/session": session, "@/lib/roles": roles,
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
  });
  const login = load("app/api/login/route.ts", {
    "@/lib/atencion-push-device": { revokeAttentionPushDevice: async () => {} },
    "next/server": { NextResponse }, "@/lib/prisma": { default: prisma },
    "@/lib/password": password, "@/lib/session": session, "@/lib/roles": roles,
  });
  const change = load("app/api/usuarios/contrasena/route.ts", {
    "next/server": { NextResponse }, "@/lib/prisma": { default: prisma },
    "@/lib/password": password, "@/lib/auth": auth, "@/lib/roles": roles,
    "@/lib/session": { ...session, createSessionToken(...args) {
      if (failSigning) throw new Error("Isolated signing failure");
      return session.createSessionToken(...args);
    } },
  });
  const protectedRoute = load("app/api/session/route.ts", {
    "next/server": { NextResponse }, "@/lib/auth": auth,
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
  });
  const sendLogin = (record = user, clave = OLD_PASSWORD) => login.POST(new Request("https://finser.test/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: record.usuario, clave }),
  }));
  return {
    session, password, user, other, writes, legacyUpgradeWrites, logs, sendLogin,
    nextSecond() { now += 1000; },
    setSigningFailure() { failSigning = true; },
    setCompareAndSwapFailure() { failCompareAndSwap = true; },
    setBeforeLegacyUpgrade(callback) { beforeLegacyUpgrade = callback; },
    async login(record = user) {
      const response = await sendLogin(record);
      assert.equal(response.status, 200);
      return response.cookies.get(session.SESSION_COOKIE_NAME).value;
    },
    async check(token) { activeToken = token; return protectedRoute.GET(); },
    async change(token, body = {}) {
      activeToken = token;
      return change.PATCH(new Request("https://finser.test/api/usuarios/contrasena", {
        method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://finser.test",
          Host: "finser.test", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD, ...body }),
      }));
    },
    signedVersion(value) {
      const payload = Buffer.from(JSON.stringify({ userId: user.id, credentialVersion: value,
        exp: Math.floor(now / 1000) + 3600 })).toString("base64url");
      return payload + "." + crypto.createHmac("sha256", TEST_SECRET).update(payload).digest("base64url");
    },
  };
}

for (const central of [true, false]) {
  const profile = central ? "Admin Central" : "Admin Aliados";
  test(`${profile}: cambiar contraseña revoca dos sesiones previas y conserva la renovada sin afectar otra cuenta`, async () => {
    const f = harness({ central });
    const first = await f.login();
    f.nextSecond();
    const second = await f.login();
    assert.notEqual(first, second, "Dos inicios separados deben producir cookies distintas");
    const otherModern = await f.login(f.other);
    const otherLegacy = f.session.createSessionToken(f.other.id);
    const unchangedOther = structuredClone(f.other);
    for (const token of [first, second, otherModern, otherLegacy]) assert.equal((await f.check(token)).status, 200);

    const previousHash = f.user.claveHash;
    const response = await f.change(first, { userId: f.other.id, id: f.other.id });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const cookie = response.cookies.get(f.session.SESSION_COOKIE_NAME);
    assert.ok(cookie?.value);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, "lax");
    assert.equal(cookie.path, "/");
    assert.equal(cookie.maxAge, f.session.SESSION_MAX_AGE_SECONDS);
    assert.notEqual(cookie.value, first);
    assert.notEqual(f.user.claveHash, previousHash);
    assert.equal(f.password.verifyPassword(NEW_PASSWORD, f.user.claveHash), true);
    assert.equal(f.password.verifyPassword(OLD_PASSWORD, f.user.claveHash), false);
    assert.ok(f.user.legacySessionRevokedAt instanceof Date);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].where.id, f.user.id);
    assert.equal(f.writes[0].where.claveHash, previousHash);
    assert.equal(f.session.verifySessionToken(cookie.value).credentialVersion,
      f.session.getSessionCredentialVersion(f.user.claveHash));
    for (const token of [first, second]) {
      assert.equal((await f.check(token)).status, 401);
      assert.equal((await f.change(token)).status, 401);
    }
    const current = await f.check(cookie.value);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).id, f.user.id);
    assert.equal((await f.sendLogin(f.user, OLD_PASSWORD)).status, 401);
    assert.equal((await f.sendLogin(f.user, NEW_PASSWORD)).status, 200);
    for (const token of [otherModern, otherLegacy]) assert.equal((await f.check(token)).status, 200);
    assert.deepEqual(f.other, unchangedOther);
    assert.equal(f.writes.length, 1);
    const visible = await response.text();
    for (const secret of [OLD_PASSWORD, NEW_PASSWORD, previousHash, f.user.claveHash]) {
      assert.ok(!visible.includes(secret));
      assert.ok(!f.logs.join(" ").includes(secret));
    }
  });

  test(`${profile}: la cookie anterior al despliegue funciona hasta el primer cambio de contraseña`, async () => {
    const f = harness({ central });
    const legacy = f.session.createSessionToken(f.user.id);
    assert.equal((await f.check(legacy)).status, 200);
    const response = await f.change(legacy);
    assert.equal(response.status, 200);
    assert.equal((await f.check(legacy)).status, 401);
    assert.equal((await f.check(response.cookies.get(f.session.SESSION_COOKIE_NAME).value)).status, 200);
  });

  test(`${profile}: el marcador rechaza cookies legacy y una edición de perfil conserva sesiones modernas`, async () => {
    const f = harness({ central });
    const token = await f.login();
    const legacy = f.session.createSessionToken(f.user.id);
    f.user.updatedAt = new Date("2026-10-29T10:00:00.000Z");
    f.user.nombre = "Nombre de prueba editado";
    assert.equal((await f.check(token)).status, 200);
    assert.equal((await f.check(legacy)).status, 200);
    f.user.legacySessionRevokedAt = new Date();
    assert.equal((await f.check(legacy)).status, 401);
    assert.equal((await f.check(token)).status, 200);
    assert.equal(f.writes.length, 0);
  });

  test(`${profile}: login migra una credencial histórica mediante CAS y emite la versión del hash guardado`, async () => {
    const f = harness({ central });
    f.user.claveHash = OLD_PASSWORD;
    const token = await f.login();
    assert.equal(f.legacyUpgradeWrites.length, 1);
    const mutation = f.legacyUpgradeWrites[0];
    assert.equal(mutation.where.id, f.user.id);
    assert.equal(mutation.where.activo, true);
    assert.equal(mutation.where.rolId, f.user.rol.id);
    assert.equal(mutation.where.claveHash, OLD_PASSWORD);
    assert.equal(f.password.isPasswordHash(f.user.claveHash), true);
    assert.equal(f.password.verifyPassword(OLD_PASSWORD, f.user.claveHash), true);
    assert.equal(f.user.legacySessionRevokedAt, null);
    assert.equal(f.session.verifySessionToken(token).credentialVersion,
      f.session.getSessionCredentialVersion(f.user.claveHash));
    assert.equal((await f.check(token)).status, 200);
    assert.equal(f.writes.length, 0);
  });

  test(`${profile}: un login histórico concurrente no sobrescribe una contraseña recién cambiada ni emite cookie`, async () => {
    const f = harness({ central });
    f.user.claveHash = OLD_PASSWORD;
    const legacy = f.session.createSessionToken(f.user.id);
    let current;
    let replacementHash;
    f.setBeforeLegacyUpgrade(async () => {
      const changed = await f.change(legacy);
      assert.equal(changed.status, 200);
      current = changed.cookies.get(f.session.SESSION_COOKIE_NAME).value;
      replacementHash = f.user.claveHash;
    });
    const response = await f.sendLogin();
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(f.legacyUpgradeWrites.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.user.claveHash, replacementHash);
    assert.equal(f.password.verifyPassword(OLD_PASSWORD, f.user.claveHash), false);
    assert.equal(f.password.verifyPassword(NEW_PASSWORD, f.user.claveHash), true);
    assert.ok(f.user.legacySessionRevokedAt instanceof Date);
    assert.equal((await f.check(legacy)).status, 401);
    assert.equal((await f.check(current)).status, 200);
    assert.equal((await f.sendLogin(f.user, OLD_PASSWORD)).status, 401);
    assert.equal((await f.sendLogin(f.user, NEW_PASSWORD)).status, 200);
  });
}

test("una versión presente vacía, de tipo incorrecto o diferente nunca se interpreta como cookie legacy", async () => {
  const f = harness();
  for (const version of ["", null, 0, false, {}, [], "different-password-version"]) {
    assert.equal((await f.check(f.signedVersion(version))).status, 401, JSON.stringify(version));
  }
  const token = await f.login();
  f.user.claveHash = f.password.hashPassword("isolated-external-reset-passphrase");
  assert.equal((await f.check(token)).status, 401);
  assert.equal(f.writes.length, 0);
});

test("si falla la firma de la cookie nueva no se escribe contraseña ni marcador de revocación", async () => {
  const f = harness();
  const token = await f.login();
  const original = structuredClone(f.user);
  f.setSigningFailure();
  const response = await f.change(token);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.user, original);
  assert.equal((await f.check(token)).status, 200);
  assert.equal(f.logs.length, 1);
  assert.ok(!f.logs[0].includes("Isolated signing failure"));
});

test("un conflicto de actualización no entrega la cookie preparada ni cambia la cuenta", async () => {
  const f = harness();
  const token = await f.login();
  const original = structuredClone(f.user);
  f.setCompareAndSwapFailure();
  const response = await f.change(token);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.user, original);
  assert.equal((await f.check(token)).status, 200);
});
