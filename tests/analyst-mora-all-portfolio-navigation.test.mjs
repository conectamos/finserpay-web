import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const node = (type, props) => typeof type === "function" ? type(props) : { type, props };
const stub = name => props => ({ type: name, props });
const icons = new Proxy({}, { get: (_, name) => stub(String(name)) });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
  [value, ...nodes(value.props?.children)];
const hrefs = tree => nodes(tree).filter(item => item.type === "Link").map(item => item.props.href);
const target = "/dashboard/aprobaciones/gestion-cartera";

function load(path, mocks = {}) {
  const loaded = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "next/link") return { default: stub("Link") };
      if (name === "lucide-react") return icons;
      if (name === "@/lib/roles") return { isAdminRole: role => role === "ADMIN", isApprovalAnalystRole: role => role === "ANALISTA_APROBACION" };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name.endsWith("finser-brand")) return { default: stub("FinserBrand") };
      if (name.endsWith("central-dashboard-menu")) return { default: stub("CentralDashboardMenu") };
      if (name.endsWith("logout-button")) return { default: stub("LogoutButton") };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return loaded.exports;
}

test("Gestión de cartera exige el guard nominal antes de renderizar el listado completo", async () => {
  const denied = new Error("Usuario sin acceso nominal");
  let allowed = false, guardCalls = 0;
  const page = load("app/dashboard/aprobaciones/gestion-cartera/page.tsx", {
    "@/app/dashboard/_components/admin-workspace-topbar": { default: stub("Topbar") },
    "../approval-dashboard-shell": { default: stub("Shell") },
    "../mora-dashboard-access": { requireMoraDashboardAccess: async () => {
      guardCalls++;
      if (!allowed) throw denied;
      return { user: { nombre: "Analista nominal", rolNombre: "ANALISTA_APROBACION" } };
    } },
    "../cartera-mora/mora-portfolio-client": { default: stub("Portfolio") },
  });
  await assert.rejects(page.default({ searchParams: Promise.resolve({ creditId: "44" }) }), error => error === denied);
  allowed = true;
  const tree = await page.default({ searchParams: Promise.resolve({}) });
  assert.equal(guardCalls, 2);
  assert.equal(tree.type, "Shell");
  assert.equal(tree.props.activeHref, target);
  const portfolio = nodes(tree).find(item => item.type === "Portfolio");
  assert.equal(portfolio.props.scope, "all");
  assert.equal(portfolio.props.initialCreditId, null);
  for (const [creditId, expected] of [["44", 44], ["-1", null], ["1.5", null], [["44", "45"], null], ["9007199254740992", null]]) {
    const linked = await page.default({ searchParams: Promise.resolve({ creditId }) });
    assert.equal(nodes(linked).find(item => item.type === "Portfolio").props.initialCreditId, expected);
  }
});

test("el menú nominal del analista conserva mora y añade todos los créditos", () => {
  const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx").default;
  const links = hrefs(Sidebar({ activeHref: target, adminCentral: false, nombreUsuario: "Analista", rolUsuario: "ANALISTA_APROBACION" }));
  assert.ok(links.includes(target));
  assert.ok(links.includes("/dashboard/aprobaciones/cartera-mora"));
  assert.ok(links.includes("/dashboard/aprobaciones/excepciones-mora"));
});

test("el sidebar central ofrece Gestión de cartera sin exponer el acceso a un administrador aliado", () => {
  const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx").default;
  for (const adminCentral of [false, true]) {
    const links = hrefs(Sidebar({ activeHref: target, adminCentral, nombreUsuario: "Administrador", rolUsuario: "ADMIN" }));
    assert.equal(links.includes(target), adminCentral);
  }
});

test("los menús horizontales centrales mantienen el acceso en todas sus variantes", () => {
  const Navigation = load("app/dashboard/_components/finser-navigation.tsx").default;
  for (const variant of ["sale", "requests", "reports", "settlement"]) {
    for (const adminCentral of [false, true]) {
      const links = hrefs(Navigation({ admin: true, adminCentral, nombreUsuario: "Administrador", rolUsuario: "ADMIN", variant }));
      assert.equal(links.includes(target), adminCentral, `${variant}, central=${adminCentral}`);
    }
  }
});
