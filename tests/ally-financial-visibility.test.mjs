import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function loadDashboard() {
  const dashboardPath = "app/dashboard/_components/admin-central-dashboard.tsx";
  const source = readFileSync(path.join(projectRoot, dashboardPath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = { exports: {} };
  const Icon = (props) => jsxRuntime.jsx("svg", props);
  const icons = new Proxy(
    {},
    {
      get() {
        return Icon;
      },
    }
  );
  const Link = ({ href, children, ...props }) =>
    jsxRuntime.jsx("a", { href: String(href), ...props, children });
  const EmptyComponent = () => null;

  runInNewContext(
    outputText,
    {
      exports: loaded.exports,
      module: loaded,
      require(name) {
        const dependencies = {
          "react/jsx-runtime": jsxRuntime,
          "next/link": { __esModule: true, default: Link },
          "lucide-react": icons,
          "./admin-sidebar": { __esModule: true, default: EmptyComponent },
          "./portfolio-health-panel": { __esModule: true, default: EmptyComponent },
          "./dashboard-month-selector": {
            __esModule: true,
            default: EmptyComponent,
          },
        };

        assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
        return dependencies[name];
      },
    },
    { filename: dashboardPath }
  );

  return loaded.exports.default;
}

const AdminCentralDashboard = loadDashboard();
const dashboardData = {
  activeCredits: 79,
  activePlacedCapital: 178_979_123,
  investedCapital: 200_000_000,
  totalCredits: 83,
  closedCredits: 4,
  accumulatedCollection: 35_000_000,
  alertsCount: 0,
  creditPerformance: [],
  criticalBalance: 0,
  criticalCredits: 0,
  criticalPercent: 0,
  currentMonthKey: "2026-09",
  daily: [
    {
      creditCount: 1,
      day: 1,
      placedCapital: 1_000_000,
      recaudo: 0,
    },
  ],
  delinquencyPercent: 0,
  dueToday: 0,
  earlyBalance: 0,
  earlyClients: 0,
  earlyPercent: 0,
  healthyBalance: 351_400_000,
  healthyPercent: 100,
  monthKey: "2026-09",
  monthLabel: "septiembre de 2026",
  monthlyCollection: 0,
  monthlyCreditCount: 1,
  monthlyPaymentCount: 0,
  monthlyPlacedCapital: 1_000_000,
};

function renderDashboard(adminCentral) {
  return renderToStaticMarkup(
    jsxRuntime.jsx(AdminCentralDashboard, {
      adminCentral,
      aliadoNombre: "JG COMPANY",
      data: dashboardData,
      nombreUsuario: "Admin aliado",
      rolUsuario: "ADMIN",
      sedeLabel: "Todas las sedes autorizadas",
    })
  );
}

test("el dashboard aliado oculta los detalles monetarios de cartera sana y seguimiento", () => {
  const html = renderDashboard(false);

  const cards = html.match(/<article\b[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, 5);
  for (const [index, label] of ["Inversión", "Total créditos", "Créditos activos", "Créditos cancelados", "Recaudo acumulado"].entries()) assert.ok(cards[index].includes(label));
  for (const [index, value] of ["200.000.000", ">83<", ">79<", ">4<", "35.000.000"].entries()) assert.ok(cards[index].includes(value));
  assert.doesNotMatch(cards.join(""), /Recaudo del mes|Cartera al dia|Capital original invertido/);

  assert.doesNotMatch(html, /\$ 351,4 M sin mora/);
  assert.doesNotMatch(html, /\$ 0 en seguimiento/);
  assert.doesNotMatch(html, /sin mora|en seguimiento/);
});

test("el dashboard central muestra los seis indicadores solicitados", () => {
  const html = renderDashboard(true);

  const cards = html.match(/<article\b[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, 6);
  for (const [index, label] of ["Capital colocado", "Cartera activa", "Total créditos", "Créditos activos", "Créditos finalizados", "Recaudo acumulado"].entries()) assert.ok(cards[index].includes(label));
  for (const [index, value] of ["200.000.000", "178.979.123", ">83<", ">79<", ">4<", "35.000.000"].entries()) assert.ok(cards[index].includes(value));
  assert.doesNotMatch(cards.join(""), /Recaudo del mes|Cartera al dia|sin mora|en seguimiento/);
});

function findJsxLabel(sourceFile, expectedLabel) {
  let found = null;

  function visit(node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.text === "label" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === expectedLabel
    ) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function isInsideAdminCentralBranch(node) {
  for (let current = node; current; current = current.parent) {
    if (
      ts.isConditionalExpression(current) &&
      ts.isIdentifier(current.condition) &&
      current.condition.text === "adminCentral"
    ) {
      const start = node.getStart();
      return (
        start >= current.whenTrue.getStart() && start < current.whenTrue.getEnd()
      );
    }
  }

  return false;
}

test("Cartera reserva Saldo por cobrar, Ganancia estimada y Respaldo para central", () => {
  const carteraPath = path.join(projectRoot, "app/dashboard/cartera/page.tsx");
  const source = readFileSync(carteraPath, "utf8");
  const sourceFile = ts.createSourceFile(
    carteraPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  for (const label of ["Saldo por cobrar", "Ganancia estimada", "Respaldo"]) {
    const labelNode = findJsxLabel(sourceFile, label);

    assert.ok(labelNode, `Debe conservarse la tarjeta ${label} para central`);
    assert.equal(
      isInsideAdminCentralBranch(labelNode),
      true,
      `${label} debe renderizarse únicamente para el administrador central`
    );
  }
});
