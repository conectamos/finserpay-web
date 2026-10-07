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

function loadSidebar() {
  const sidebarPath = "app/dashboard/_components/admin-sidebar.tsx";
  const source = readFileSync(path.join(projectRoot, sidebarPath), "utf8");
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
          "@/app/_components/finser-brand": {
            __esModule: true,
            default: EmptyComponent,
          },
          "@/lib/roles": {
            isAdminRole: (role) => String(role || "").toUpperCase() === "ADMIN",
            isApprovalAnalystRole: (role) =>
              String(role || "").toUpperCase() === "ANALISTA_APROBACION",
          },
          "./logout-button": {
            __esModule: true,
            default: EmptyComponent,
          },
        };

        assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
        return dependencies[name];
      },
    },
    { filename: sidebarPath }
  );

  return loaded.exports.default;
}

const AdminSidebar = loadSidebar();

function renderSidebar({ adminCentral, rolUsuario, activeHref = "/dashboard" }) {
  return renderToStaticMarkup(
    jsxRuntime.jsx(AdminSidebar, {
      activeHref,
      adminCentral,
      nombreUsuario: "Usuario de prueba",
      rolUsuario,
    })
  );
}

test("Cartera aparece en el menu de administradores centrales y aliados", () => {
  const central = renderSidebar({ adminCentral: true, rolUsuario: "ADMIN" });
  const aliado = renderSidebar({ adminCentral: false, rolUsuario: "ADMIN" });

  assert.match(central, /href="\/dashboard\/cartera"/);
  assert.match(aliado, /href="\/dashboard\/cartera"/);
  assert.match(central, /href="\/dashboard\/cartera\/detalle-mora"/);
  assert.match(aliado, /href="\/dashboard\/cartera\/detalle-mora"/);
});

test("Cartera no aparece en el menu de perfiles que no son administradores", () => {
  for (const rolUsuario of [
    "VENDEDOR",
    "SUPERVISOR",
    "ANALISTA_APROBACION",
  ]) {
    const html = renderSidebar({ adminCentral: false, rolUsuario });

    assert.doesNotMatch(
      html,
      /href="\/dashboard\/cartera"/,
      `El rol ${rolUsuario} no debe ver Cartera`
    );
    assert.doesNotMatch(html, /href="\/dashboard\/cartera\/detalle-mora"/);
  }
});

test("Detalle de mora permanece activo dentro del submenú Cartera en escritorio y móvil", () => {
  const html = renderSidebar({ adminCentral: false, rolUsuario: "ADMIN", activeHref: "/dashboard/cartera/detalle-mora" });
  assert.equal((html.match(/href="\/dashboard\/cartera\/detalle-mora" aria-current="page"/g) || []).length, 2);
  assert.equal((html.match(/<details open="" class="group\/cartera"/g) || []).length, 2);
});
