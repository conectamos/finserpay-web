import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

const [dashboard, dialog, page] = await Promise.all([
  readProjectFile("app/dashboard/_components/seller-commercial-dashboard.tsx"),
  readProjectFile("app/dashboard/_components/seller-client-app-dialog.tsx"),
  readProjectFile("app/dashboard/page.tsx"),
]);

test("el dashboard comercial conserva metricas y creditos dinamicos", () => {
  for (const field of [
    "stats.creditosHoy",
    "stats.creditosMes",
    "stats.pendientesEntrega",
    "stats.abonosHoy",
  ]) {
    assert.ok(dashboard.includes(field), `falta la metrica dinamica ${field}`);
  }

  assert.match(dashboard, /recentCredits\.map\(\(credit\)/);
  assert.match(dashboard, /<table[\s\S]*?<tbody/);
  assert.match(page, /creditosHoy[\s\S]*creditosMes[\s\S]*pendientesEntrega/);
});

test("la navegacion comercial mantiene sus rutas principales", () => {
  const routes = [
    ["/dashboard", "Inicio"],
    ["/dashboard/creditos", "Nueva venta"],
    ["/dashboard/solicitudes", "Solicitudes"],
    ["/dashboard/creditos?mode=simulator", "Simulador"],
    ["/dashboard/pin", "Cambiar PIN"],
  ];

  for (const [href, label] of routes) {
    assert.ok(dashboard.includes(`href: "${href}"`), `falta la ruta ${label}`);
  }

  assert.match(dashboard, /label: "Retomar solicitud"/);
});

test("la app de clientes se abre en un dialogo y no queda fija en el tablero", () => {
  assert.doesNotMatch(dashboard, /CLIENT_APP_QR_PATH|finserpay-clientes-qr\.svg/);
  assert.match(dashboard, /<SellerClientAppDialog \/>/);
  assert.match(dialog, /dialog\.showModal\(\)/);
  assert.match(dialog, /finserpay-clientes-qr\.svg/);
  assert.match(dialog, /target="_blank"/);
  assert.match(dialog, /rel="noopener noreferrer"/);
});

test("el rediseno elimina tarjetas laterales y colores turquesa anteriores", () => {
  assert.doesNotMatch(dashboard, /Perfil activo|MetricCard|ActionCard/);
  assert.doesNotMatch(dashboard, /#087a73|#43c7bd|#55d2c7/i);
  assert.match(dashboard, /Indicadores comerciales/);
  assert.match(dashboard, /recent-credits-title/);
});
