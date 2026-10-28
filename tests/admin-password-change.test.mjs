import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const origin = "https://finser.example";
const central = { id: 8, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
const valid = { currentPassword: "Anterior-2026!", newPassword: "Nueva-segura-2026!", confirmPassword: "Nueva-segura-2026!" };

function harness({ user = central, account: suppliedAccount, updateCount = 1, dbError = null } = {}) {
  const calls = { reads: [], writes: [], sessions: 0 };
  const cache = new Map();
  let account;
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(path.join(root, file), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    } });
    const mod = { exports: {} };
    const scopedRequire = (name) => {
      if (name === "@/lib/auth") return { getSessionUser: async () => { calls.sessions++; return user; } };
      if (name === "@/lib/prisma") return { usuario: {
        findUnique: async (query) => { calls.reads.push(query); if (dbError) throw dbError; return account; },
        updateMany: async (query) => { calls.writes.push(query); return { count: updateCount }; },
      } };
      if (name.startsWith("@/")) {
        const suffix = name === "@/app/_components/finser-ui" ? ".tsx" : ".ts";
        return load(`${name.slice(2)}${suffix}`);
      }
      return require(name);
    };
    new Function("require", "module", "exports", outputText)(scopedRequire, mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  }
  const password = load("lib/password.ts");
  account = suppliedAccount === undefined
    ? { id: user?.id ?? 8, activo: true, claveHash: password.hashPassword(valid.currentPassword), rolId: 1, rol: { nombre: "ADMIN" } }
    : suppliedAccount;
  return { calls, account, password, load, route: load("app/api/usuarios/contrasena/route.ts") };
}

function patch(body = valid, headers = {}, url = `${origin}/api/usuarios/contrasena`) {
  return new Request(url, { method: "PATCH", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("solo permite administradores autenticados y no consulta credenciales de otros perfiles", async () => {
  for (const [user, expected] of [[null, 401], [{ ...central, rolNombre: "VENDEDOR" }, 403], [{ ...central, rolNombre: "ANALISTA_APROBACIONES" }, 403]]) {
    const h = harness({ user });
    assert.equal((await h.route.PATCH(patch())).status, expected);
    assert.equal(h.calls.reads.length, 0);
    assert.equal(h.calls.writes.length, 0);
  }
});

test("admin aliado y central actualizan solo su cuenta con scrypt y nunca devuelven secretos", async () => {
  for (const user of [central, { ...central, id: 9, aliadoAccesoCodigo: "ALIADO" }]) {
    const h = harness({ user });
    const response = await h.route.PATCH(patch({ ...valid, userId: 999, id: 999, rolId: 999 }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.deepEqual(h.calls.reads[0].where, { id: user.id });
    assert.deepEqual(h.calls.writes[0].where, { id: user.id, activo: true, rolId: 1, claveHash: h.account.claveHash });
    const stored = h.calls.writes[0].data.claveHash;
    assert.equal(h.password.isPasswordHash(stored), true);
    assert.equal(h.password.verifyPassword(valid.newPassword, stored), true);
    assert.equal(h.password.verifyPassword(valid.currentPassword, stored), false);
    assert.deepEqual(Object.keys(h.calls.writes[0].data), ["claveHash"]);
    const body = await response.text();
    for (const secret of [valid.currentPassword, valid.newPassword, stored, h.account.claveHash]) assert.equal(body.includes(secret), false);
  }
});

test("contraseña actual incorrecta no modifica datos", async () => {
  const h = harness();
  const response = await h.route.PATCH(patch({ ...valid, currentPassword: "incorrecta" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /actual no coincide/);
  assert.equal(h.calls.writes.length, 0);
});

test("valida confirmación, tipos y longitud en servidor antes de consultar hashes", async () => {
  for (const body of [
    null, [], {}, { ...valid, currentPassword: 123 }, { ...valid, newPassword: {} },
    { ...valid, confirmPassword: valid.newPassword + "x" },
    { ...valid, newPassword: "corta", confirmPassword: "corta" },
    { ...valid, newPassword: "x".repeat(129), confirmPassword: "x".repeat(129) },
    { ...valid, newPassword: " ".repeat(10), confirmPassword: " ".repeat(10) },
    { ...valid, currentPassword: "x".repeat(1025) },
    { ...valid, newPassword: valid.currentPassword, confirmPassword: valid.currentPassword },
  ]) {
    const h = harness();
    assert.equal((await h.route.PATCH(patch(body))).status, 400);
    assert.equal(h.calls.reads.length, 0);
    assert.equal(h.calls.writes.length, 0);
  }
});

test("conserva espacios y caracteres Unicode en la contraseña nueva", async () => {
  const h = harness();
  const next = "  Nueva-contraseña-é!  ";
  assert.equal((await h.route.PATCH(patch({ ...valid, newPassword: next, confirmPassword: next }))).status, 200);
  assert.equal(h.password.verifyPassword(next, h.calls.writes[0].data.claveHash), true);
  assert.equal(h.password.verifyPassword(next.trim(), h.calls.writes[0].data.claveHash), false);
});

test("protege contra origen externo o ausente antes de consultar la sesión", async () => {
  for (const headers of [{ origin: "" }, { origin: "https://attacker.example" }, { origin: "null" }, { origin: `${origin}/path` }, { origin: "https://user@finser.example" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
    const h = harness();
    assert.equal((await h.route.PATCH(patch(valid, headers))).status, 403);
    assert.equal(h.calls.sessions, 0);
  }
  const h = harness();
  assert.equal((await h.route.PATCH(patch(valid, { host: "finser.example" }, "http://internal:3000/api/usuarios/contrasena"))).status, 200);
});

test("rechaza cuerpos incorrectos, extensos y formatos que no sean JSON", async () => {
  const h = harness();
  assert.equal((await h.route.PATCH(patch(valid, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await h.route.PATCH(patch({ ...valid, excess: "x".repeat(8192) }))).status, 400);
  assert.equal((await h.route.PATCH(new Request(`${origin}/api/usuarios/contrasena`, {
    method: "PATCH", headers: { origin, "content-type": "application/json" }, body: "{bad",
  }))).status, 400);
  assert.equal(h.calls.reads.length, 0);
});

test("cuenta inactiva, inexistente o sin rol administrativo no puede mutar credenciales", async () => {
  for (const account of [null, { activo: false }, { activo: true, rol: { nombre: "VENDEDOR" } }]) {
    const h = harness({ account });
    assert.equal((await h.route.PATCH(patch())).status, 403);
    assert.equal(h.calls.writes.length, 0);
  }
});

test("un cambio concurrente de credencial o rol devuelve conflicto", async () => {
  const h = harness({ updateCount: 0 });
  assert.equal((await h.route.PATCH(patch())).status, 409);
  assert.equal(h.calls.writes[0].where.claveHash, h.account.claveHash);
  assert.equal(h.calls.writes[0].where.rolId, 1);
});

test("limita intentos por cuenta antes de nuevas verificaciones de hash", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) assert.equal((await h.route.PATCH(patch({ ...valid, currentPassword: "incorrecta" }))).status, 400);
  const response = await h.route.PATCH(patch());
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(h.calls.reads.length, 5);
  assert.equal(h.calls.writes.length, 0);
});

test("fallos de persistencia no exponen parámetros sensibles en respuesta ni logs", async () => {
  const h = harness({ dbError: new Error(`DB params ${valid.newPassword}`) });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = await h.route.PATCH(patch());
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes(valid.newPassword), false);
    assert.equal(logged.join(" ").includes(valid.newPassword), false);
  } finally { console.error = original; }
});

test("formulario renderiza tres campos ocultos con labels, autocompletado y límites", () => {
  const h = harness();
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const Form = h.load("app/dashboard/contrasena/password-change-form.tsx").default;
  const html = renderToStaticMarkup(React.createElement(Form));
  assert.equal((html.match(/type="password"/g) || []).length, 3);
  for (const name of ["currentPassword", "newPassword", "confirmPassword"]) assert.match(html, new RegExp(`name="${name}"`));
  assert.match(html, /autoComplete="current-password"/);
  assert.equal((html.match(/autoComplete="new-password"/g) || []).length, 2);
  assert.match(html, /Guardar contraseña/);
  assert.equal(html.includes(valid.currentPassword), false);
});
