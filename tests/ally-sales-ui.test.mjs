import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const empty = () => null;
const component = value => ({ __esModule: true, default: value });
function load(file, dependencies) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(read(file), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { module: loaded, exports: loaded.exports, URLSearchParams,
    require(name) {
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".module.css")) return component(new Proxy({}, { get: (_, key) => String(key) }));
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return loaded.exports;
}
const roles = load("lib/roles.ts", {});
const ui = load("app/_components/finser-ui.tsx", {});
const Dashboard = load("app/dashboard/_components/admin-central-dashboard.tsx", {
  "next/link": component(({ children, ...props }) => jsx.jsx("a", { ...props, children })),
  "lucide-react": new Proxy({}, { get: () => empty }),
  "@/lib/roles": roles, "@/app/_components/finser-ui": ui,
  "@/app/_components/finser-brand": component(empty), "./logout-button": component(empty),
  "./central-dashboard-filters": component(empty),
  "./central-dashboard-menu": component(({ label, children }) => jsx.jsxs("details", { children: [jsx.jsx("summary", { children: label }), children] })),
  "./attention-notifications": { AttentionNotificationBell: empty },
}).default;

for (const adminCentral of [false, true]) {
  test(`el administrador ${adminCentral ? "central" : "aliado"} inicia Nueva venta desde menú y acción`, () => {
    const product = { totalBalance: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0 };
    const html = renderToStaticMarkup(jsx.jsx(Dashboard, {
      adminCentral, rolUsuario: "ADMIN", nombreUsuario: "Administradora de prueba", aliadoNombre: "Aliado de prueba",
      availableSedes: [], allies: [], selectedSede: null, selectedAlly: null,
      data: { productHealth: { IPHONE: product, ANDROID: product }, creditPerformance: [], daily: [] },
    }));
    assert.equal([...html.matchAll(/href="\/dashboard\/creditos\?mode=create-client"/g)].length, 2);
    assert.equal([...html.matchAll(/>Nueva venta<\/a>/g)].length, 2);
    assert.ok(html.includes("/dashboard/creditos?mode=simulator"));
    assert.equal(html.includes("/dashboard/creditos-masivos"), adminCentral);
  });
}

for (const platform of ["android", "iphone"]) {
  test(`la ruta del admin aliado abre venta ${platform} sin exigir perfil vendedor`, async () => {
    let sellerReads = 0;
    const Console = () => null;
    const Page = load("app/dashboard/creditos/page.tsx", {
      "next/navigation": { redirect: href => { throw new Error(`Unexpected redirect ${href}`); } },
      "next/link": component(empty), "lucide-react": { ArrowLeft: empty, ShieldCheck: empty },
      "@/lib/auth": { getSessionUser: async () => ({ id: 9, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoId: 20, sedeId: 201 }) },
      "@/lib/seller-auth": { getSellerSessionUser: async () => { sellerReads++; return null; } },
      "@/lib/roles": roles, "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
      "@/app/_components/finser-ui": ui, "./credit-factory-console": component(Console),
      "./credit-platform-selector": component(empty), "./credit-evidence-gallery": { ApprovedCreditEvidenceCorrection: empty },
      "./approved-credit-equipment-replacement": { ApprovedCreditEquipmentReplacement: empty },
    }).default;
    const result = await Page({ searchParams: Promise.resolve({ mode: "create-client", platform }) });
    assert.equal(result.type, Console);
    assert.equal(result.props.entryMode, "create-client");
    assert.equal(result.props.devicePlatform, platform);
    assert.equal(result.props.initialSeller, null);
    assert.equal(sellerReads, 0);
  });
}

test("la interfaz conserva la revisión de identidad y navegación libre exclusivas de central", () => {
  const source = read("app/dashboard/creditos/credit-factory-console.tsx");
  const ast = ts.createSourceFile("console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  const visit = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "FirmaSeguroIdentityReview") matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(matches.length, 1);
  const permission = matches[0].attributes.properties.find(attribute => attribute.name?.getText(ast) === "canAdmin");
  assert.equal(permission.initializer.expression.getText(ast), "canSeeInternalPricing");
  assert.match(source, /const canAdminMoveFreelyInFactory = canSeeInternalPricing && createClientMode/);
});
