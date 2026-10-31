import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const simulatorHref = "/dashboard/creditos?mode=simulator";
const Empty = () => null;
const component = value => ({ __esModule: true, default: value });
const Link = ({ children, ...props }) => jsxRuntime.jsx("a", { ...props, children });
const Menu = ({ label, children }) => jsxRuntime.jsxs("details", { children: [jsxRuntime.jsx("summary", { children: label }), children] });
const Icon = () => jsxRuntime.jsx("svg", { "aria-hidden": true });
const styles = new Proxy({}, { get: (_, key) => String(key) });
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function execute(code, context = {}) {
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: {}, require: name => {
    assert.equal(name, "react/jsx-runtime");
    return jsxRuntime;
  }, ...context }, { timeout: 1000 });
}
function load(file, extra = {}, globals = {}) {
  const loaded = { exports: {} };
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    "next/link": component(Link),
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/app/_components/finser-brand": component(Empty),
    "./central-dashboard-menu": component(Menu),
    "./central-dashboard-filters": component(Empty),
    "./logout-button": component(Empty),
    "./attention-notifications": { AttentionNotificationBell: Empty },
    ...extra,
  };
  execute(read(file), { module: loaded, exports: loaded.exports, ...globals, require: name => {
    if (name.endsWith(".module.css")) return component(styles);
    assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
    return dependencies[name];
  } });
  return loaded.exports;
}
const roles = load("lib/roles.ts");
const ui = load("app/_components/finser-ui.tsx");
const common = { "@/lib/roles": roles, "@/app/_components/finser-ui": ui };
const Navigation = load("app/dashboard/_components/finser-navigation.tsx", common).default;
const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx", common).default;
const Dashboard = load("app/dashboard/_components/admin-central-dashboard.tsx", common).default;
const hrefs = html => Array.from(html.matchAll(/href="([^"]+)"/g), match => match[1].replace(/&amp;/g, "&"));
const render = (type, props) => renderToStaticMarkup(jsxRuntime.jsx(type, props));

function dashboardProps(adminCentral, rolUsuario = "ADMIN") {
  const product = { totalBalance: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0 };
  return {
    adminCentral, rolUsuario, nombreUsuario: "Administradora conectada", aliadoNombre: "Aliado de prueba",
    availableSedes: [], allies: [], selectedSede: null, selectedAlly: null,
    data: {
      productHealth: { IPHONE: product, ANDROID: product }, creditPerformance: [], daily: [],
      investedCapital: 0, activePlacedCapital: 0, accumulatedCollection: 0,
      totalCredits: 0, activeCredits: 0, closedCredits: 0, alertsCount: 0,
      monthlyCreditCount: 0, monthlyPaymentCount: 0, monthlyPlacedCapital: 0, monthlyCollection: 0,
      healthyPercent: 0, earlyPercent: 0, criticalPercent: 0,
      dueToday: 0, earlyClients: 0, criticalCredits: 0,
    },
  };
}

for (const central of [false, true]) {
  test(`el inicio ${central ? "central" : "aliado"} ofrece Simulador en Operación y Simular en Acciones`, () => {
    const tree = Dashboard(dashboardProps(central));
    const header = renderToStaticMarkup(tree.props.children[0]);
    const main = renderToStaticMarkup(tree.props.children[1]);
    assert.equal(hrefs(header).filter(href => href === simulatorHref).length, 1);
    assert.match(header, />Simulador<\/a>/);
    assert.equal(hrefs(main).filter(href => href === simulatorHref).length, 1);
    assert.match(main, /href="\/dashboard\/creditos\?mode=simulator"[^>]*><svg[^>]*><\/svg>Simular<\/a>/);
    for (const path of ["/dashboard/creditos-masivos", "/dashboard/comisiones", "/dashboard/parametros-credito"]) {
      assert.equal(hrefs(header).includes(path), central, `${path} conserva permiso exclusivamente central`);
    }
    assert.equal(hrefs(main).includes("/dashboard/creditos-masivos"), central);
  });

  test(`las navegaciones compartidas conservan acceso del administrador ${central ? "central" : "aliado"}`, () => {
    for (const variant of ["sale", "requests", "reports", "settlement"]) {
      const html = render(Navigation, { admin: true, adminCentral: central, variant, nombreUsuario: "Admin", rolUsuario: "ADMIN" });
      assert.equal(hrefs(html).filter(href => href === simulatorHref).length, 1);
    }
    const html = render(Sidebar, { adminCentral: central, activeHref: simulatorHref, nombreUsuario: "Admin", rolUsuario: "ADMIN" });
    const menus = Array.from(html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g), match => match[1]);
    assert.equal(menus.length, 2);
    for (const menu of menus) assert.equal(hrefs(menu).filter(href => href === simulatorHref).length, 1);
  });
}

function routeFixture({ central = false, role = "ADMIN", seller = null, authenticated = true } = {}) {
  const session = { id: 7, nombre: "Administradora conectada", rolNombre: role, aliadoId: central ? 1 : 25, aliadoAccesoCodigo: central ? "FINSERPAY" : "ALIADO", sedeNombre: "Sede de prueba" };
  const redirects = [];
  const Console = () => null;
  const Selector = () => null;
  const Page = load("app/dashboard/creditos/page.tsx", {
    ...common,
    "next/navigation": { redirect: href => { redirects.push(href); throw new Error("NEXT_REDIRECT"); } },
    "@/lib/auth": { getSessionUser: async () => authenticated ? session : null },
    "@/lib/seller-auth": { getSellerSessionUser: async () => seller },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "./credit-factory-console": component(Console),
    "./credit-platform-selector": component(Selector),
    "./credit-evidence-gallery": { ApprovedCreditEvidenceCorrection: Empty },
    "./approved-credit-equipment-replacement": { ApprovedCreditEquipmentReplacement: Empty },
  }, { URLSearchParams }).default;
  return { session, redirects, Console, Selector, Page: params => Page({ searchParams: Promise.resolve(params) }) };
}

test("la ruta real permite al administrador aliado seleccionar Android e iPhone e iniciar cada simulación", async () => {
  for (const central of [false, true]) {
    const fixture = routeFixture({ central });
    const choice = await fixture.Page({ mode: "simulator" });
    assert.equal(choice.type, fixture.Selector);
    assert.equal(choice.props.admin, true);
    assert.equal(choice.props.adminCentral, central);
    assert.equal(choice.props.mode, "simulator");
    for (const platform of ["android", "iphone"]) {
      assert.equal(choice.props[`${platform}Href`], `/dashboard/creditos?mode=simulator&platform=${platform}`);
      const console = await fixture.Page({ mode: "simulator", platform });
      assert.equal(console.type, fixture.Console);
      assert.equal(console.props.entryMode, "simulator");
      assert.equal(console.props.devicePlatform, platform);
      assert.equal(console.props.initialSession, fixture.session);
      assert.equal(console.props.initialDraftId, null);
      assert.equal(console.props.initialSelectedId, null);
    }
    assert.deepEqual(fixture.redirects, []);
  }
});

test("el acceso añadido conserva autenticación y no autoriza abrir otros créditos ni correcciones centrales", async () => {
  const unauthenticated = routeFixture({ authenticated: false });
  assert.match(renderToStaticMarkup(await unauthenticated.Page({ mode: "simulator" })), /No autenticado/);
  const noProfile = routeFixture({ role: "VENDEDOR" });
  await assert.rejects(noProfile.Page({ mode: "simulator", platform: "iphone" }), /NEXT_REDIRECT/);
  assert.deepEqual(noProfile.redirects, ["/dashboard"]);
  for (const params of [{ mode: "simulator", selected: "123", platform: "iphone" }, { mode: "replacement", selected: "123" }, { mode: "correction", selected: "123" }]) {
    const ally = routeFixture();
    await assert.rejects(ally.Page(params), /NEXT_REDIRECT/);
    assert.deepEqual(ally.redirects, ["/dashboard/solicitudes"]);
  }
});

const consoleAst = ts.createSourceFile("credit-factory-console.tsx", read("app/dashboard/creditos/credit-factory-console.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionNode(predicate) {
  const matches = [];
  const visit = node => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(consoleAst);
  assert.equal(matches.length, 1, "Debe existir una única expresión de producción");
  return matches[0];
}
const variable = name => productionNode(node => ts.isVariableDeclaration(node) && node.name.getText(consoleAst) === name);
function pricingAccess({ role = "ADMIN", central = false, simulator = true } = {}) {
  const declarations = ["canAdmin", "canSeeInternalPricing", "paymentsView", "lookupView", "simulatorMode", "canSeeEquipmentBasePrice"].map(name => `const ${variable(name).getText(consoleAst)};`).join("\n");
  return execute(`${declarations}\n({canAdmin,canSeeInternalPricing,canSeeEquipmentBasePrice,simulatorMode});`, {
    initialSession: { rolNombre: role, aliadoAccesoCodigo: central ? "FINSERPAY" : "ALIADO" },
    esAliadoFinserPay: code => code === "FINSERPAY", view: "factory", entryMode: simulator ? "simulator" : "create-client",
  });
}
const currency = value => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);

test("el aliado ve precio base únicamente en el simulador sin recibir el desglose financiero central", () => {
  assert.equal(pricingAccess().canSeeEquipmentBasePrice, true);
  assert.equal(pricingAccess().canSeeInternalPricing, false);
  assert.equal(pricingAccess({ simulator: false }).canSeeEquipmentBasePrice, false);
  assert.equal(pricingAccess({ central: true }).canSeeEquipmentBasePrice, true);
  assert.equal(pricingAccess({ central: true, simulator: false }).canSeeInternalPricing, true);
  for (const role of ["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"]) {
    assert.equal(pricingAccess({ role }).canSeeEquipmentBasePrice, false);
    assert.equal(pricingAccess({ role }).canSeeInternalPricing, false);
  }
});

test("el aviso real de precio base conserva COP completo, validación y ajuste de venta", () => {
  const hint = productionNode(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(consoleAst) === "small" && node.getText(consoleAst).includes('"Precio base: "'));
  const hintHtml = (access, price = 2_575_000, adjustment = 0, invalid = false) => renderToStaticMarkup(execute(`(${hint.getText(consoleAst)})`, {
    ...access, valorEquipoTotal: invalid ? "0" : "2575000", valorTotalEquipoNumero: invalid ? 0 : 2_575_000,
    precioBaseVentaCatalogo: price, excedentePrecioBase: adjustment, currency,
  }));
  for (const central of [false, true]) {
    assert.match(hintHtml(pricingAccess({ central })), /Precio base: \$\s*2\.575\.000\./);
    assert.doesNotMatch(hintHtml(pricingAccess({ central })), /,00|\d+\s*M\b/);
  }
  assert.match(hintHtml(pricingAccess(), 2_575_000, 75_000), /Ajuste sobre base: \$\s*75\.000/);
  assert.doesNotMatch(hintHtml(pricingAccess({ role: "VENDEDOR" })), /Precio base/);
  assert.doesNotMatch(hintHtml(pricingAccess(), 0), /Precio base/);
  assert.match(hintHtml(pricingAccess(), 2_575_000, 0, true), /El precio debe ser mayor que cero/);
});

test("cada opción real del selector muestra el precio base del modelo para ambos administradores", () => {
  const option = productionNode(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(consoleAst) === "option" && node.getText(consoleAst).includes("canSeeEquipmentBasePrice"));
  for (const central of [false, true]) {
    const html = renderToStaticMarkup(execute(`(${option.getText(consoleAst)})`, {
      ...pricingAccess({ central }), currency, item: { id: 31, modelo: "iPhone de prueba 128GB", precioBaseVenta: 2_575_000 },
    }));
    assert.match(html, /iPhone de prueba 128GB/);
    assert.match(html, /\$\s*2\.575\.000/);
  }
  const sellerHtml = renderToStaticMarkup(execute(`(${option.getText(consoleAst)})`, {
    ...pricingAccess({ role: "VENDEDOR" }), currency, item: { id: 31, modelo: "Equipo de prueba", precioBaseVenta: 2_575_000 },
  }));
  assert.doesNotMatch(sellerHtml, /2\.575\.000/);
});

function selectModel({ item, central = false, role = "ADMIN", simulator = true, allowed = true, previous = 0, current = "" }) {
  const changes = [];
  const apply = variable("applyEquipmentCatalogItem");
  execute(`const ${apply.getText(consoleAst)}; applyEquipmentCatalogItem(item);`, {
    ...pricingAccess({ role, central, simulator }), item, currentDevicePlatform: "iphone", iphoneFactory: true,
    isEquipmentCatalogItemAllowedForPlatform: () => allowed, selectedEquipmentCatalogItem: previous ? { precioBaseVenta: previous } : null,
    valorEquipoTotal: current,
    setEquipoMarca: value => changes.push(["marca", value]), setEquipoModelo: value => changes.push(["modelo", value]),
    setRestoredEquipmentCatalogId: value => changes.push(["id", value]),
    setValorEquipoTotal: value => changes.push(["precio", value]), setNotice: value => changes.push(["error", value.text]),
    fetch: () => assert.fail("Elegir un modelo no debe consultar ni persistir datos"),
    requestJson: () => assert.fail("Elegir un modelo no debe guardar un borrador ni consultar al proveedor"),
  });
  return changes;
}

test("seleccionar o cambiar un modelo aplica su precio base real al simulador de ambos administradores sin escrituras", () => {
  for (const central of [false, true]) {
    const first = { id: 31, marca: "IPHONE", modelo: "Modelo A", precioBaseVenta: 2_575_000 };
    const next = { id: 32, marca: "IPHONE", modelo: "Modelo B", precioBaseVenta: 3_149_990 };
    assert.deepEqual(selectModel({ central, item: first }), [["marca", "IPHONE"], ["modelo", "Modelo A"], ["id", 31], ["precio", "2575000"]]);
    assert.deepEqual(selectModel({ central, item: next, previous: 2_575_000, current: "2600000" }).at(-1), ["precio", "3149990"]);
  }
});

test("elegir modelo conserva el comportamiento comercial y rechaza equipos de otra plataforma", () => {
  const item = { id: 31, marca: "IPHONE", modelo: "Modelo A", precioBaseVenta: 2_575_000 };
  assert.ok(!selectModel({ item, simulator: false, current: "2600000" }).some(([key]) => key === "precio"));
  assert.deepEqual(selectModel({ item, simulator: false, previous: 2_000_000, current: "2000000" }).at(-1), ["precio", ""]);
  assert.ok(!selectModel({ item, role: "VENDEDOR" }).some(([key]) => key === "precio"));
  const rejected = selectModel({ item, allowed: false });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0][0], "error");
});

test("el precio de la simulación permanece editable para comparar otra propuesta", () => {
  const input = productionNode(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(consoleAst) === "input" && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(consoleAst) === "id" && attr.initializer?.getText(consoleAst) === '"step-two-price"'));
  const handler = input.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(consoleAst) === "onChange").initializer.expression;
  const values = [];
  execute(`(${handler.getText(consoleAst)})(event)`, { event: { target: { value: "$ 2.650.000" } }, setValorEquipoTotal: value => values.push(value) });
  assert.deepEqual(values, ["2650000"]);
});
