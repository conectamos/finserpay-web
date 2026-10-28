import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const element = (type, props) => ({ type, props });
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "Fragment" };
    if (name === "next/link") return { default: "Link" };
    if (name.endsWith(".module.css")) return { default: {} };
    if (name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  } }, { filename: file });
  return module.exports;
}
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const roles = load("lib/roles.ts");
const central = { id: 7, nombre: "Administradora Central", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", activo: true };
const analyst = { ...central, id: 19, rolNombre: "ANALISTA_APROBACION", sedeAccesoActiva: true, aliadoAccesoActivo: true };

function approvalPage({ user = central, nominal = user, shared } = {}) {
  return load("app/dashboard/aprobaciones/page.tsx", {
    "next/navigation": { redirect: href => { throw Error(`REDIRECT:${href}`); } },
    "@/app/_components/finser-ui": { Card: "Card" },
    "@/app/revision-creditos/shared-logout": { default: "SharedLogout" },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/auth": { getCreditApprovalSessionUser: async () => user, getNominalApprovalWorkspaceSessionUser: async () => nominal },
    "@/lib/roles": roles,
    "./approval-dashboard-shell": { default: "Shell" },
    "./approval-workspace": { default: "Workspace" },
  }).default;
}

test("Admin Central abre el muro operativo desde Analistas y conserva Aprobaciones administrativa", async () => {
  for (const vista of [undefined, "analista"]) {
    const tree = await approvalPage()({ searchParams: Promise.resolve({ vista, credito: "42" }) });
    const workspace = nodes(tree).find(node => node.type === "Workspace");
    assert.equal(workspace.props.analystDesk, vista === "analista");
    assert.equal(tree.props.analystWorkspace, vista === "analista");
    assert.equal(tree.props.user.id, central.id);
    assert.equal(workspace.props.userName, central.nombre);
    assert.equal(workspace.props.allowOperations, true);
    assert.equal(workspace.props.canManageSadmin, true);
    assert.equal(workspace.props.initialFocusApprovalCreditId, 42);
  }
});

test("el parámetro visual no concede permisos ni cambia la identidad del actor", async () => {
  for (const options of [{ nominal: null }, { nominal: analyst }, { shared: null }, { shared: { id: 4 } }]) {
    const tree = await approvalPage(options)({ searchParams: Promise.resolve({ vista: "analista" }) });
    assert.equal(nodes(tree).find(node => node.type === "Workspace").props.analystDesk, false);
  }
  const tree = await approvalPage({ user: analyst })({ searchParams: Promise.resolve({}) });
  assert.equal(nodes(tree).find(node => node.type === "Workspace").props.analystDesk, true);
  await assert.rejects(approvalPage({ user: { ...central, aliadoAccesoCodigo: "OTRO" } })({ searchParams: Promise.resolve({ vista: "analista" }) }), /REDIRECT:\/dashboard/);
});

test("las herramientas comparten cabecera analista con identidad central y retorno al panel", async () => {
  const shell = load("app/dashboard/aprobaciones/approval-dashboard-shell.tsx", {
    "@/app/_components/finser-ui": { AppShell: "AppShell" },
    "@/app/dashboard/_components/admin-sidebar": { default: "Sidebar" },
    "@/app/dashboard/_components/finser-navigation": { default: "FinserNavigation" },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/roles": roles,
    "@/lib/auth": { getNominalApprovalWorkspaceSessionUser: async () => central },
    "./analyst-navigation": { default: "AnalystNavigation" },
  }).default;
  for (const path of ["centro", "cambio-imei", "solicitudes", "firma-seguro", "sadmin", "liberar-consulta"]) {
    const tree = await shell({ activeHref: `/dashboard/aprobaciones/${path}`, user: central, children: "operación existente" });
    const nav = nodes(tree).find(node => node.type === "AnalystNavigation");
    assert.equal(nav.props.centralAdmin, true);
    assert.equal(nav.props.userRole, "ADMIN");
    assert.equal(nav.props.userName, central.nombre);
    assert.equal(nodes(tree).some(node => node.type === "Link" && node.props.href === "/dashboard/aprobaciones/centro"), path !== "centro");
  }
  const normal = await shell({ activeHref: "/dashboard/aprobaciones", user: central });
  assert.ok(nodes(normal).some(node => node.type === "FinserNavigation"));
  // Existing central tools retain their previous shell and permissions.
  for (const path of ["enrolamiento", "gestion-cartera", "cartera-mora"]) {
    const tree = await shell({ activeHref: `/dashboard/aprobaciones/${path}`, user: central });
    assert.equal(tree.type, "AppShell");
  }
  const exceptions = await shell({ activeHref: "/dashboard/aprobaciones/excepciones-mora", user: central });
  assert.ok(nodes(exceptions).some(node => node.type === "FinserNavigation"));
});

test("navegación central ofrece Analistas; ambos administradores tienen contraseña y vendedor conserva PIN", () => {
  const navigation = load("app/dashboard/_components/finser-navigation.tsx", {
    "@/app/_components/finser-brand": { default: "Brand" },
    "./central-dashboard-menu": { default: "Menu" },
    "./logout-button": { default: "Logout" },
  }).default;
  for (const variant of ["sale", "requests", "reports", "settlement", "administration"]) {
    for (const [admin, adminCentral] of [[true, true], [true, false], [false, false]]) {
      const tree = navigation({ admin, adminCentral, nombreUsuario: "Usuario", rolUsuario: admin ? "ADMIN" : "VENDEDOR", variant });
      const expanded = nodes(tree).flatMap(node => typeof node.type === "function" ? nodes(node.type(node.props)) : [node]);
      const links = expanded.filter(node => node.type === "Link").map(node => node.props.href);
      assert.equal(links.includes("/dashboard/contrasena"), admin);
      assert.equal(links.includes("/dashboard/pin"), !admin);
      assert.equal(links.includes("/dashboard/aprobaciones/centro"), adminCentral);
    }
  }
});
