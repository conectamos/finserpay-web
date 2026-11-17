import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const target = "/dashboard/aprobaciones/excepciones-mora";
const legacy = "/dashboard/excepciones-mora";
const stub = name => props => ({ type: name, props });
const node = (type, props) => typeof type === "function" ? type(props) : { type, props };
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
  [value, ...nodes(value.props?.children)];

function load(path, mocks = {}) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module: loaded, exports: loaded.exports, URLSearchParams,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "next/link") return { default: stub("Link") };
      if (name === "lucide-react") return new Proxy({}, { get: (_, icon) => stub(String(icon)) });
      if (name === "@/lib/roles") return { isAdminRole: role => role === "ADMIN", isApprovalAnalystRole: role => role === "ANALISTA_APROBACION" };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name.endsWith("finser-brand")) return { default: stub("FinserBrand") };
      if (name.endsWith("central-dashboard-menu")) return { default: stub("CentralDashboardMenu") };
      if (name.endsWith("logout-button")) return { default: stub("LogoutButton") };
      if (name === "./attention-notifications") return { AttentionNotificationBell: stub("AttentionNotificationBell") };
      throw new Error(`Unexpected import ${name}`);
    },
  }, { filename: path });
  return loaded.exports;
}

function oldPage(guard) {
  const redirects = [];
  const page = load("app/dashboard/excepciones-mora/page.tsx", {
    "@/lib/dashboard-access": { requireCentralAdminDashboardAccess: guard },
    "next/navigation": { redirect(destination) {
      redirects.push(destination);
      throw Object.assign(new Error("Synthetic redirect"), { destination });
    } },
  }).default;
  return { page, redirects };
}

test("la entrada antigua comprueba acceso central y abre directamente el listado sin crear una solicitud", async () => {
  const events = [];
  let allowed = false;
  const { page, redirects } = oldPage(async () => {
    events.push("guard"); await Promise.resolve(); allowed = true;
  });
  const searchParams = { then(resolve) { assert.equal(allowed, true); events.push("params"); resolve({}); } };
  await assert.rejects(page({ searchParams }), error => error.destination === target);
  assert.deepEqual(events, ["guard", "params"]);
  assert.deepEqual(redirects, [target]);
  assert.equal(new URL(target, "https://finserpay.com").searchParams.has("nueva"), false);
});

test("la falta de acceso conserva el rechazo del guard sin leer parámetros ni redirigir al listado", async () => {
  const denied = new Error("Synthetic access denied");
  const { page, redirects } = oldPage(async () => { throw denied; });
  let reads = 0;
  await assert.rejects(page({ searchParams: { then() { reads++; throw new Error("Must not read params"); } } }), error => error === denied);
  assert.equal(reads, 0);
  assert.equal(redirects.length, 0);
});

test("los enlaces antiguos conservan parámetros repetidos, vacíos y caracteres codificados sin cambiar el destino", async () => {
  const params = { credito: ["77", "88"], nueva: "1", q: "María & Gómez?", status: "APPROVED", empty: "", omitted: undefined,
    repeated: ["a&b", "c?d"], returnTo: "https://example.invalid/other" };
  const { page, redirects } = oldPage(async () => {});
  await assert.rejects(page({ searchParams: Promise.resolve(params) }), error => typeof error.destination === "string");
  const url = new URL(redirects[0], "https://finserpay.com");
  assert.equal(url.origin, "https://finserpay.com"); assert.equal(url.pathname, target);
  assert.deepEqual(url.searchParams.getAll("credito"), ["77", "88"]);
  assert.deepEqual(url.searchParams.getAll("repeated"), ["a&b", "c?d"]);
  for (const key of ["nueva", "q", "status", "empty", "returnTo"]) assert.equal(url.searchParams.get(key), params[key]);
  assert.equal(url.searchParams.has("omitted"), false);
});

test("la página canónica conserva el guard nominal y empieza con listado, sin crédito ni formulario abierto", async () => {
  for (const centralAdmin of [true, false]) {
    let guards = 0;
    const page = load("app/dashboard/aprobaciones/excepciones-mora/page.tsx", {
      "../mora-dashboard-access": { requireMoraDashboardAccess: async () => {
        guards++;
        return { actor: { centralAdmin }, user: { nombre: "Usuario de prueba", rolNombre: centralAdmin ? "ADMIN" : "ANALISTA_APROBACION" } };
      } },
      "../approval-dashboard-shell": { default: stub("Shell") },
      "@/app/dashboard/_components/admin-workspace-topbar": { default: stub("Topbar") },
      "./mora-exception-requests-client": { default: stub("Requests") },
    }).default;
    const tree = await page({ searchParams: Promise.resolve({}) });
    const client = nodes(tree).find(item => item.type === "Requests");
    assert.equal(guards, 1); assert.equal(tree.props.activeHref, target);
    assert.equal(client.props.centralAdmin, centralAdmin);
    assert.equal(client.props.initialCreditId, null); assert.equal(client.props.initialCreateOpen, false);
  }
});

test("el sidebar central enlaza al listado y mantiene su selección activa sin ampliar el acceso aliado", () => {
  const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx").default;
  for (const adminCentral of [true, false]) {
    const links = nodes(Sidebar({ activeHref: target, adminCentral, nombreUsuario: "Administrador", rolUsuario: "ADMIN" }))
      .filter(item => item.type === "Link");
    assert.equal(links.some(item => item.props.href === target), adminCentral);
    assert.equal(links.some(item => item.props.href === legacy), false);
    if (adminCentral) assert.ok(links.filter(item => item.props.href === target).every(item => item.props["aria-current"] === "page"));
  }
  const analystLinks = nodes(Sidebar({ activeHref: target, adminCentral: false, nombreUsuario: "Analista", rolUsuario: "ANALISTA_APROBACION" }))
    .filter(item => item.type === "Link");
  assert.ok(analystLinks.some(item => item.props.href === target && item.props["aria-current"] === "page"));
});

test("los menús horizontales centrales abren el listado directamente en todas sus variantes", () => {
  const Navigation = load("app/dashboard/_components/finser-navigation.tsx").default;
  for (const variant of ["sale", "requests", "reports", "settlement", "administration"]) {
    for (const adminCentral of [true, false]) {
      const links = nodes(Navigation({ admin: true, adminCentral, nombreUsuario: "Administrador", rolUsuario: "ADMIN", variant }))
        .filter(item => item.type === "Link").map(item => item.props.href);
      assert.equal(links.includes(target), adminCentral, `${variant}, central=${adminCentral}`);
      assert.equal(links.includes(legacy), false);
    }
  }
});
