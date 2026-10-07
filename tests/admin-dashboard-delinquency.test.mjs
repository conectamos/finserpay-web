import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { summarizeDashboardDelinquency } = await jiti.import("../lib/dashboard-delinquency.ts");

function approximately(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} debe ser ${expected}`);
}

function row(id, fields = {}) {
  return {
    id, saldoPendiente: 100, overdue: true, estado: "GENERADO", pazYSalvoEmitidoAt: null,
    sedeId: 70, vendedorId: 2, vendedor: { id: 2, nombre: "Ana", documento: "222" },
    usuario: { id: 9, nombre: "Administrador del aliado", usuario: "admin" },
    sede: { id: 70, nombre: "Centro", aliado: { id: 7, nombre: "Aliado 7" } },
    ...fields,
  };
}

test("distribuye el mismo saldo en mora de Salud; participación suma100 y cartera6", () => {
  const data = summarizeDashboardDelinquency([
    row(1, { saldoPendiente: 330 }),
    row(2, { saldoPendiente: 270, sedeId: 71, vendedorId: 3,
      vendedor: { id: 3, nombre: "Carlos" },
      sede: { id: 71, nombre: "Norte", aliado: { id: 7, nombre: "Aliado 7" } } }),
    row(3, { saldoPendiente: 9400, overdue: false }),
  ]);
  assert.equal(data.activeCredits, 3);
  assert.equal(data.overdueCredits, 2);
  assert.equal(data.totalBalance, 10000);
  assert.equal(data.overdueBalance, 600);
  assert.equal(data.overduePortfolioPercent, 6);
  assert.equal(data.overduePercent, 2 / 3 * 100);
  approximately(data.sites[0].overdueSharePercent, 55);
  approximately(data.sites[0].overduePortfolioPercent, 3.3);
  assert.equal(data.sites[0].overduePercent, 50);
  for (const groups of [data.sites, data.sellers]) {
    assert.equal(groups.reduce((sum, group) => sum + group.overdueCredits, 0), 2);
    assert.equal(groups.reduce((sum, group) => sum + group.overdueBalance, 0), 600);
    approximately(groups.reduce((sum, group) => sum + group.overdueSharePercent, 0), 100);
    approximately(groups.reduce((sum, group) => sum + group.overduePortfolioPercent, 0), 6);
  }
});

test("cuenta créditos únicos sin juntar clientes ni múltiples apariciones de cuotas", () => {
  const first = row(1, { clienteDocumento: "100" });
  const data = summarizeDashboardDelinquency([first, first, row(2, { clienteDocumento: "100" })]);
  assert.equal(data.activeCredits, 2);
  assert.equal(data.overdueCredits, 2);
  assert.equal(data.overdueBalance, 200);
  assert.equal(data.sites[0].overdueCredits, 2);
});

test("omite pagados, paz y salvo y créditos anulados o cancelados; caso vacío sin NaN", () => {
  const data = summarizeDashboardDelinquency([
    row(1, { saldoPendiente: 0 }), row(2, { pazYSalvoEmitidoAt: new Date() }),
    ...["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].map((estado, index) => row(3 + index, { estado })),
  ]);
  assert.deepEqual(data, {
    activeCredits: 0, overdueCredits: 0, overduePercent: 0, totalBalance: 0,
    overdueBalance: 0, overduePortfolioPercent: 0, sites: [], sellers: [],
  });
  const healthy = summarizeDashboardDelinquency([row(10, { overdue: false })]);
  assert.equal(healthy.sites[0].overdueSharePercent, 0);
  assert.equal(healthy.overduePortfolioPercent, 0);
});

test("sedes y vendedores homónimos son entidades distintas; IDsUsuario no colisionan", () => {
  const data = summarizeDashboardDelinquency([
    row(1),
    row(2, { sedeId: 80, sede: { id: 80, nombre: "Centro", aliado: { id: 8, nombre: "Aliado 8" } },
      vendedorId: 3, vendedor: { id: 3, nombre: "Ana" } }),
    row(3, { vendedorId: null, vendedor: null, usuario: { id: 2, nombre: "Ana", usuario: "ana" } }),
  ]);
  assert.equal(data.sites.length, 2);
  assert.deepEqual(data.sites.map(group => group.key), ["sede:70", "sede:80"]);
  assert.equal(data.sites[0].context, "Aliado 7");
  assert.equal(data.sites[1].context, "Aliado 8");
  assert.equal(data.sellers.length, 3);
  assert.deepEqual(data.sellers.map(group => group.key), ["usuario:2", "vendedor:2", "vendedor:3"]);
});

test("la sede y vendedor con más mora se ordenan por saldo, después número y claves estables", () => {
  const rows = [row(1), row(2), row(3, { saldoPendiente: 300, vendedor: { id: 3, nombre: "Beatriz" } })];
  const original = summarizeDashboardDelinquency(rows);
  assert.equal(original.sellers[0].key, "vendedor:3");
  assert.equal(original.sellers[0].overdueCredits, 1);
  assert.deepEqual(original, summarizeDashboardDelinquency([...rows].reverse()));
});

test("imports sólo atribuyen responsables asignados validamente y no al creador del lote", () => {
  const imported = {
    vendedorId: null, vendedor: null, contratoAceptadoAt: null, pagareAceptadoAt: null,
    contratoFirmaDataUrl: null,
    contratoSnapshot: {
      origen: { tipo: "IMPORTACION_MASIVA", sinFirmaDigital: true },
      asignacion: { tipoResponsable: "ADMINISTRADOR", vendedorId: null,
        responsableUsuarioId: 15, vendedor: "Responsable importado", sedeId: 70 },
    },
  };
  const data = summarizeDashboardDelinquency([
    row(1, imported),
    row(2, { ...imported, contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA", sinFirmaDigital: true } } }),
    row(3, { ...imported, contratoAceptadoAt: new Date() }),
    row(4, { ...imported, contratoFirmaDataUrl: "PRESENTE" }),
    row(5, { ...imported, contratoSnapshot: { ...imported.contratoSnapshot,
      asignacion: { ...imported.contratoSnapshot.asignacion, sedeId: 999 } } }),
    row(6, { ...imported, vendedorId: 2, vendedor: { id: 2, nombre: "Vendedor real" } }),
  ]);
  const unassigned = data.sellers.find(group => group.unassigned);
  assert.equal(unassigned.name, "Sin vendedor asignado");
  assert.equal(unassigned.overdueCredits, 4);
  assert.equal(data.sellers.find(group => group.key === "usuario:15").overdueCredits, 1);
  assert.equal(data.sellers.find(group => group.key === "vendedor:2").overdueCredits, 1);
  assert.equal(data.sellers.some(group => group.key === "usuario:9"), false);
  approximately(data.sellers.reduce((sum, group) => sum + group.overdueSharePercent, 0), 100);
});
