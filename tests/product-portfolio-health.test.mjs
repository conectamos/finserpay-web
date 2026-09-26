import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const health = await jiti.import("../lib/product-portfolio-health.ts");
const dependencies = Object.fromEntries(await Promise.all([
  "credit-capital", "credit-payment-plan", "dashboard-month", "ally-payments-core", "product-portfolio-health",
].map(async (name) => [`@/lib/${name}`, await jiti.import(`../lib/${name}.ts`)])));
const now = new Date("2026-09-26T17:00:00Z");
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
const source = readFileSync(new URL("../app/dashboard/_lib/admin-dashboard-data.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });

function credit(id, brand, balance, days, ally=1, extra={}) {
  const due = new Date(now); due.setUTCDate(due.getUTCDate() - days);
  return { id, clienteDocumento: String(id), clienteNombre: `Cliente ${id}`, equipoMarca: brand,
    contratoSnapshot: null, estado: "ACTIVO", cuotaInicial: 0, fechaCredito: new Date("2026-08-01T17:00:00Z"),
    fechaPrimerPago: due, fechaProximoPago: due, frecuenciaPago: "MENSUAL", montoCredito: balance,
    pazYSalvoEmitidoAt: null, plazoMeses: 1, saldoBaseFinanciado: balance / 2,
    sede: { aliadoId: ally, aliado: { nombre: `Aliado ${ally}` }, nombre: "Sede" },
    valorCuota: balance, valorEquipoTotal: balance / 2, valorFianza: 0, valorInteres: balance / 2, ...extra };
}
function loadOverview(credits, payments=[]) {
  const calls = {};
  const prisma = {
    credito: { findMany: async args => {
      calls.credits = args;
      return credits.filter(c => c.estado !== args.where.estado.not && (!args.where.sede || c.sede.aliadoId === args.where.sede.aliadoId));
    } },
    creditoAbono: {
      groupBy: async args => { calls.payments=args; return payments; },
      findMany: async args => {calls.month=args;return [];},
    },
  };
  const module = { exports: {} };
  runInNewContext(outputText, { module, exports: module.exports, Date: FixedDate, Intl,
    require: name => name === "@/lib/prisma" ? { default: prisma } : dependencies[name],
  });
  return { get: module.exports.getAdminDashboardOverview, calls };
}

test("porcentajes por saldo propio, no por cantidad de créditos ni por capital colocado", async () => {
  const { get } = loadOverview([credit(1,"Apple",900,0),credit(2,"Apple",100,1),credit(3,"Samsung",100,0,2),credit(4,"Samsung",900,16,2)]);
  const overview=await get();
  assert.equal(overview.healthyPercent,50);
  assert.equal(overview.earlyPercent,5);
  assert.equal(overview.criticalPercent,45);
  assert.equal(overview.productHealth.IPHONE.earlyPercent,10);
  assert.equal(overview.productHealth.IPHONE.overdueBalance,100);
  assert.equal(overview.productHealth.IPHONE.totalBalance,1000);
  assert.equal(overview.productHealth.ANDROID.criticalPercent,90);
  assert.equal(overview.productHealth.ANDROID.overdueBalance,900);
  assert.equal(overview.productHealth.ANDROID.totalBalance,1000);
});

test("conserva límites de la general: 0 días, 1 día, 15 días y 16 días", async () => {
  const {get}=loadOverview([credit(1,"Apple",100,0),credit(2,"Apple",200,1),credit(3,"Apple",300,15),credit(4,"Apple",400,16)]);
  const data=await get();const iphone=data.productHealth.IPHONE;
  assert.equal(iphone.healthyBalance,100);assert.equal(iphone.earlyBalance,500);assert.equal(iphone.criticalBalance,400);
  assert.equal(iphone.healthyPercent,data.healthyPercent);assert.equal(iphone.earlyPercent,data.earlyPercent);assert.equal(iphone.criticalPercent,data.criticalPercent);
});

test("usa el saldo restante tras abonos y excluye créditos cancelados o a paz y salvo", async () => {
  const {get}=loadOverview([credit(1,"Apple",1000,1),credit(2,"Apple",3000,1,1,{pazYSalvoEmitidoAt:now}),credit(3,"Apple",4000,16,1,{estado:"ANULADO"})], [{creditoId:1,_sum:{valor:250}}]);
  const data=await get();assert.equal(data.productHealth.IPHONE.totalBalance,750);assert.equal(data.productHealth.IPHONE.overdueBalance,750);
  assert.equal(data.productHealth.IPHONE.overduePercent,100);assert.equal(data.activeCredits,1);
});

test("respeta el filtro de aliado y comparte la actualización mensual de la general", async () => {
  const {get,calls}=loadOverview([credit(1,"Apple",100,1,1),credit(2,"Samsung",900,16,2)]);
  const data=await get({aliadoId:2,month:"2026-08"});
  assert.equal(calls.credits.where.sede.aliadoId,2);assert.equal(calls.payments.where.credito.sede.aliadoId,2);
  assert.equal(calls.month.where.fechaAbono.gte.toISOString(),"2026-08-01T05:00:00.000Z");
  assert.equal(data.productHealth.IPHONE.totalBalance,0);assert.equal(data.productHealth.ANDROID.totalBalance,900);
  assert.equal(data.productHealth.ANDROID.criticalPercent,data.criticalPercent);
  // El selector mensual cambia recaudo/colocación; Salud conserva la cartera vigente.
  const otherMonth=await get({aliadoId:2,month:"2026-07"});
  assert.deepEqual(otherMonth.productHealth,data.productHealth);
});

test("reutiliza la plataforma contractual, su fallback histórico y no inventa productos", async () => {
  const {get,calls}=loadOverview([credit(1,"Apple",100,1,1,{contratoSnapshot:{equipo:{plataforma:"ANDROID"}}}),credit(2,"Apple iPhone",200,0),credit(3,"",300,16)]);
  const data=await get();assert.equal(calls.credits.select.contratoSnapshot,true);assert.equal(calls.credits.select.equipoMarca,true);
  assert.equal(data.productHealth.ANDROID.totalBalance,100);assert.equal(data.productHealth.IPHONE.totalBalance,200);
  assert.equal(data.unclassifiedPortfolioBalance,300);assert.equal(data.criticalBalance,300);
});

test("productos vacíos o sin saldo no generan NaN ni porcentajes de mora ficticios", () => {
  for(const rows of [[],[{platform:"IPHONE",bucket:"critica",saldoPendiente:0}]]){
    const data=health.summarizeProductPortfolioHealth(rows);
    for(const product of Object.values(data)) for(const value of Object.values(product)) assert.equal(value,0);
  }
});
