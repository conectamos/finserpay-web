import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const target = "/dashboard/atencion";
const node = (type, props) => typeof type === "function" ? type(props) : { type, props };
const stub = name => props => ({ type: name, props });
const icons = new Proxy({}, { get: (_, name) => stub(String(name)) });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];
const hrefs = tree => nodes(tree).filter(item => item.type === "Link").map(item => item.props.href);

function load(file, mocks = {}) {
  const loaded = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    module: loaded, exports: loaded.exports, URL, Date, Intl,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "react") return { useState: initial => [initial, () => {}], useRef: initial => ({ current: initial }), useEffect: () => {} };
      if (name === "next/link") return { default: stub("Link") };
      if (name === "next/image") return { default: stub("Image") };
      if (name === "lucide-react") return icons;
      if (name === "@/lib/roles") return { isAdminRole: role => role === "ADMIN", isApprovalAnalystRole: role => role === "ANALISTA_APROBACION" };
      if (name === "@/lib/credit-display-number") return { creditDisplayNumber: () => "Prueba" };
      if (name === "@/lib/cartera-export") return { isExcludedCarteraCreditState: () => false };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name.endsWith("finser-ui")) return new Proxy({}, { get: (_, key) => stub(String(key)) });
      if (/finser-brand|central-dashboard-menu|logout-button|seller-client-app-dialog|seller-commissions|seller-dashboard-refresh|central-dashboard-filters|credit-welcome-voice-result/.test(name)) return { default: stub(name) };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return loaded.exports;
}

function request(pathname, cookieValues = {}, method = "GET") {
  return { method, nextUrl: { pathname, search: "?q=test", clone() { return { pathname: this.pathname, search: this.search }; } },
    cookies: { get: name => cookieValues[name] ? { value: cookieValues[name] } : undefined }, headers: { get: () => null } };
}
const { proxy } = load("proxy.ts", { "next/server": { NextResponse: {
  next: () => ({ kind: "next" }), json: (body, options) => ({ kind: "json", body, status: options?.status ?? 200 }),
  redirect: url => ({ kind: "redirect", pathname: url.pathname }),
} } });

test("nominal analyst reaches only the attention route family in addition to existing permissions", () => {
  const cookies = { approval_analyst_session: "nominal-cookie" };
  for (const [path, method] of [[target, "GET"], ["/api/atencion", "GET"], ["/api/atencion", "POST"], ["/api/atencion/test-id", "PATCH"], ["/api/atencion/sync", "POST"]]) {
    assert.equal(proxy(request(path, cookies, method)).kind, "next", path);
  }
  for (const path of ["/api/atencion-extra", "/api/creditos", "/api/usuarios/admin", "/api/inventario"]) assert.equal(proxy(request(path, cookies, "POST")).status, 403, path);
  assert.equal(proxy(request("/dashboard/atencion-extra", cookies)).pathname, "/dashboard/aprobaciones/centro");
});

test("anonymous and link-only contexts cannot use attention; existing approval links keep their scope", () => {
  for (const cookies of [{}, { approval_access_session: "personal-link" }, { approval_shared_session: "shared-link" }]) {
    assert.equal(proxy(request("/api/atencion", cookies)).status, 401);
    assert.equal(proxy(request(target, cookies)).pathname, "/aliados");
  }
  for (const cookies of [{ approval_access_session: "personal-link" }, { approval_shared_session: "shared-link" }]) {
    assert.equal(proxy(request("/api/aprobaciones", cookies)).kind, "next");
  }
});

test("regular session reaches the server role guard while seller-profile sessions are stopped", () => {
  assert.equal(proxy(request(target, { session: "regular-cookie" })).kind, "next");
  assert.equal(proxy(request("/api/atencion", { session: "regular-cookie" })).kind, "next");
  const seller = { session: "regular-cookie", seller_session: "seller-cookie" };
  assert.equal(proxy(request(target, seller)).pathname, "/dashboard");
  assert.equal(proxy(request("/api/atencion", seller)).status, 403);
});

const workId = "a0000000-0000-4000-8000-000000000001";
const fileId = "b0000000-0000-4000-8000-000000000002";
const sellerWorkRoutes = [
  ["/api/ventas/atencion", "GET"], ["/api/ventas/atencion", "POST"], ["/api/ventas/atencion/events", "GET"],
  [`/api/ventas/atencion/${workId}`, "GET"], [`/api/ventas/atencion/${workId}`, "PATCH"],
  [`/api/ventas/atencion/${workId}/files`, "POST"], [`/api/ventas/atencion/${workId}/files/${fileId}`, "GET"],
];
test("seller can open, create and continue own work requests through their guarded handlers", () => {
  const cookies = { session: "regular-cookie", seller_session: "seller-cookie" };
  assert.equal(proxy(request("/dashboard/gestion-comercial", cookies)).kind, "next");
  for (const [path, method] of sellerWorkRoutes) assert.equal(proxy(request(path, cookies, method)).kind, "next", `${method} ${path}`);
});
test("commercial inbox exception never opens administrative sales or unsupported actions", () => {
  const cookies = { session: "regular-cookie", seller_session: "seller-cookie" };
  for (const [path, method] of [["/api/ventas", "GET"], ["/api/ventas/123", "PATCH"], ["/api/ventas/atencion-extra", "GET"],
    ["/api/ventas/atencion", "DELETE"], ["/api/ventas/atencion/events", "POST"], [`/api/ventas/atencion/${workId}`, "DELETE"],
    [`/api/ventas/atencion/${workId}/files`, "GET"], [`/api/ventas/atencion/${workId}/files/${fileId}`, "POST"],
    [`/api/ventas/atencion/${workId}/admin`, "GET"], ["/api/ventas/atencion/not-a-uuid", "GET"], ["/api/atencion", "GET"]]) {
    assert.equal(proxy(request(path, cookies, method)).status, 403, `${method} ${path}`);
  }
});
test("seller work routes still require the account session and reject approval-link or analyst credentials", () => {
  for (const [path, method] of sellerWorkRoutes) {
    for (const cookies of [{}, { seller_session: "profile-only" }, { approval_access_session: "personal-link" }, { approval_shared_session: "shared-link" }])
      assert.equal(proxy(request(path, cookies, method)).status, 401, path);
    assert.equal(proxy(request(path, { approval_analyst_session: "analyst-cookie" }, method)).status, 403, path);
  }
});

test("sidebar offers attention to central administrators and analysts, not ally administrators", () => {
  const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx").default;
  for (const [role, central, allowed] of [["ADMIN", true, true], ["ADMIN", false, false], ["ANALISTA_APROBACION", false, true], ["VENDEDOR", false, false]]) {
    const links = hrefs(Sidebar({ activeHref: target, adminCentral: central, nombreUsuario: "Cuenta de prueba", rolUsuario: role }));
    assert.equal(links.includes(target), allowed, `${role} central=${central}`);
  }
});

test("all horizontal navigation variants keep attention exclusive to central administration", () => {
  const Navigation = load("app/dashboard/_components/finser-navigation.tsx").default;
  for (const variant of ["sale", "requests", "reports", "settlement", "administration"]) {
    for (const [admin, adminCentral] of [[true, true], [true, false], [false, true], [false, false]]) {
      const links = hrefs(Navigation({ admin, adminCentral, nombreUsuario: "Cuenta de prueba", rolUsuario: admin ? "ADMIN" : "VENDEDOR", variant }));
      assert.equal(links.includes(target), admin && adminCentral, `${variant} admin=${admin} central=${adminCentral}`);
    }
  }
  // The approval-link shell historically passes admin=true for its layout;
  // the actual role must still be ADMIN to expose a central-only menu item.
  assert.equal(hrefs(Navigation({ admin: true, adminCentral: true, nombreUsuario: "Enlace personal", rolUsuario: "ANALISTA_APROBACION" })).includes(target), false);
});

test("neither commercial seller nor commercial supervisor navigation exposes attention", () => {
  const { CommercialSidebar } = load("app/dashboard/_components/seller-commercial-dashboard.tsx");
  for (const isSupervisor of [false, true]) {
    const links = hrefs(CommercialSidebar({ activeHref: "/dashboard", avatarSrc: null, nombre: "Comercial de prueba", isSupervisor }));
    assert.equal(links.includes(target), false);
  }
});

test("central dashboard preserves its attention link and the ally dashboard omits it", () => {
  const Dashboard = load("app/dashboard/_components/admin-central-dashboard.tsx").default;
  const health = { totalBalance: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0 };
  const data = { daily: [], productHealth: { IPHONE: health, ANDROID: health }, creditPerformance: [], monthLabel: "Prueba", monthKey: "2026-10" };
  for (const adminCentral of [false, true]) {
    const links = hrefs(Dashboard({ adminCentral, aliadoNombre: "Prueba", data, nombreUsuario: "Cuenta de prueba", rolUsuario: "ADMIN", availableSedes: [], selectedSede: null, allies: [], selectedAlly: null }));
    assert.equal(links.filter(href => href === target).length, adminCentral ? 1 : 0);
  }
});

test("the nominal analyst center includes the existing attention workspace once", () => {
  const Center = load("app/dashboard/aprobaciones/centro/analyst-center.tsx").default;
  assert.equal(hrefs(Center()).filter(href => href === target).length, 1);
});
