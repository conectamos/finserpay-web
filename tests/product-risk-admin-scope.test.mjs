import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const [risk, scope, paymentPlan, colombiaDate, creditFactory, capital] = await Promise.all([
  jiti.import("../lib/product-risk.ts"), jiti.import("../lib/delinquency-detail-access.ts"),
  jiti.import("../lib/credit-payment-plan.ts"), jiti.import("../lib/colombia-date.ts"),
  jiti.import("../lib/credit-factory.ts"), jiti.import("../lib/credit-capital.ts"),
]);
const ally = { nombre: "Admin aliado", rolNombre: "ADMIN", aliadoAccesoCodigo: "JG", aliadoAccesoId: 7, aliadoAccesoNombre: "JG COMPANY" };
const central = { ...ally, nombre: "Central", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1 };
const now = Date.parse("2026-10-06T17:00:00Z");
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const source = readFileSync(new URL("../app/dashboard/riesgo-referencia/page.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const Empty = () => null;

function credit(id, fields = {}) {
  const { allyId = 7, ...changes } = fields;
  return { id, folio: `FC-${id}`, clienteNombre: `Cliente ${id}`, equipoMarca: "APPLE", equipoModelo: "IPHONE 13",
    referenciaEquipo: "IPHONE 13", estado: "ENTREGADO", montoCredito: 1110000,
    saldoBaseFinanciado: 900000, valorEquipoTotal: 1000000, cuotaInicial: 100000,
    valorFianza: 10000, valorInteres: 200000, planCapitalVigente: null,
    contratoAceptadoAt: new Date("2026-08-01"), pagareAceptadoAt: new Date("2026-08-01"),
    pazYSalvoEmitidoAt: null, fechaCredito: new Date("2026-08-01T15:00:00Z"),
    valorCuota: 555000, plazoMeses: 2, frecuenciaPago: "MENSUAL", fechaPrimerPago: new Date("2026-09-02"),
    fechaProximoPago: null, equalityService: null,
    sede: { id: id + 70, nombre: "Centro", aliadoId: allyId, aliado: { nombre: `Aliado ${allyId}` } },
    abonos: [],
    fotoEntregaDataUrl: "private photo payload", fotoRemisionDataUrl: null,
    contratoSnapshot: { equipo: { plataforma: "IPHONE" } },
    ...changes };
}
function nodes(node) {
  return !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
function project(item, select) {
  return Object.fromEntries(Object.entries(select).map(([key, selection]) => {
    const field = item[key];
    if (selection === true) return [key, field];
    if (Array.isArray(field)) return [key, field.filter(value => !selection.where?.estado?.not || value.estado !== selection.where.estado.not).map(value => project(value, selection.select))];
    return [key, field ? project(field, selection.select) : null];
  }));
}
function harness(session = ally, allCredits = [credit(1), credit(2, { estado: "ENTREGABLE", fotoEntregaDataUrl: null }),
  credit(3, { pazYSalvoEmitidoAt: new Date("2026-10-01"), estado: "PAGADO" }), credit(4, { allyId: 8 })]) {
  const calls = { access: 0, credits: [], evidence: [], management: [], numbers: [], schema: 0 };
  const db = {
    credito: { findMany: async args => {
      calls.credits.push(args);
      return allCredits.filter(item => item.montoCredito > 0 &&
        (args.where.sede?.aliadoId == null || item.sede.aliadoId === args.where.sede.aliadoId))
        .map(item => project(item, args.select));
    } },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join("?");
      const ids = [...values[0]];
      if (sql.includes('"fotoEntregaDataUrl"')) {
        calls.evidence.push({ sql, ids });
        return allCredits.filter(item => ids.includes(item.id)).map(item => ({
          id: item.id, fotoEntrega: Boolean(item.fotoEntregaDataUrl), fotoRemision: Boolean(item.fotoRemisionDataUrl),
          plataforma: item.contratoSnapshot?.equipo?.plataforma || null,
          importOriginType: item.contratoSnapshot?.origen?.tipo || null,
        }));
      }
      calls.management.push({ sql, ids });
      return allCredits.filter(item => ids.includes(item.id)).map(item => ({ creditoId: item.id,
        actedAt: new Date("2026-10-05T15:00:00Z"), action: "LLAMADA", result: "SIN_RESPUESTA", comment: `Comentario ${item.id}` }));
    },
  };
  const deps = {
    "react/jsx-runtime": jsxRuntime,
    "@/lib/prisma": { default: db },
    "@/lib/dashboard-access": { requireAdminDashboardAccess: async () => {
      calls.access++;
      if (!session || session.rolNombre !== "ADMIN") throw new Error("REDIRECT");
      return { session };
    } },
    "@/lib/delinquency-detail-access": scope,
    "@/lib/credit-payment-plan": paymentPlan,
    "@/lib/colombia-date": colombiaDate,
    "@/lib/credit-factory": creditFactory,
    "@/lib/credit-capital": capital,
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async ids => {
      calls.numbers.push([...ids]); return new Map(ids.map(id => [id, `010000${id}`]));
    } },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => { calls.schema++; } },
    "@/lib/product-risk": risk,
    "@/app/_components/finser-ui": { AppShell: Empty },
    "../_components/admin-sidebar": { default: Empty },
    "../_components/admin-workspace-topbar": { default: Empty },
    "./risk-console": { default: Empty },
  };
  const loaded = { exports: {} };
  runInNewContext(outputText, { module: loaded, exports: loaded.exports, Date: FixedDate, console,
    require(name) { assert.ok(name in deps, `Dependency missing: ${name}`); return deps[name]; } });
  return { render: loaded.exports.default, calls };
}

test("riesgo aliado consulta sólo créditos de sesión y limita evidencia, números y gestiones a sus IDs", async () => {
  const f = harness();
  const tree = await f.render({ searchParams: Promise.resolve({ aliadoId: "8", adminCentral: "true" }) });
  assert.equal(f.calls.access, 1);
  assert.equal(f.calls.credits[0].where.sede.aliadoId, 7);
  assert.deepEqual(f.calls.evidence[0].ids, [1, 2, 3]);
  assert.match(f.calls.evidence[0].sql, /WHERE "id" = ANY\(\?::int\[\]\)/);
  assert.deepEqual(f.calls.numbers, [[1, 3]]);
  assert.deepEqual(f.calls.management[0].ids, [1, 3]);
  assert.match(f.calls.management[0].sql, /WHERE event\."creditoId" = ANY\(\?::int\[\]\)/);
  for (const field of ["fotoEntregaDataUrl", "fotoRemisionDataUrl", "contratoSnapshot"]) {
    assert.equal(Object.hasOwn(f.calls.credits[0].select, field), false, `No debe cargar ${field}`);
  }
  const consoleNode = nodes(tree).find(node => node.props?.credits && node.props?.cutoff);
  assert.equal(consoleNode.props.adminCentral, false);
  assert.equal(consoleNode.props.scopeLabel, "JG COMPANY");
  assert.deepEqual(consoleNode.props.credits.map(row => row.id), [1, 3]);
  assert.equal(consoleNode.props.credits[0].activo, true);
  assert.equal(consoleNode.props.credits[1].activo, false);
  assert.doesNotMatch(JSON.stringify(consoleNode.props), /"capital"|"saldo"|"vencido"|1110000|900000|private photo payload/);
  assert.equal(consoleNode.props.credits[0].numeroCreditoVisible, "0100001");
  assert.equal(consoleNode.props.credits[0].gestion, "LLAMADA · SIN_RESPUESTA · Comentario 1");
});

test("central conserva alcance global e importes; solamente la sesión otorga esa vista", async () => {
  const f = harness(central); const tree = await f.render();
  assert.equal(Object.hasOwn(f.calls.credits[0].where, "sede"), false);
  assert.deepEqual(f.calls.evidence[0].ids, [1, 2, 3, 4]);
  assert.deepEqual(f.calls.management[0].ids, [1, 3, 4]);
  const consoleNode = nodes(tree).find(node => node.props?.credits && node.props?.cutoff);
  assert.equal(consoleNode.props.adminCentral, true);
  assert.equal(consoleNode.props.credits.length, 3);
  assert.equal(consoleNode.props.credits[0].capital, 900000);
  assert.equal(consoleNode.props.credits[0].saldo, 1110000);
  assert.equal(consoleNode.props.credits[0].vencido, 1110000);
});

test("sin alcance aliado válido, sin sesión y roles no administradores no consultan datos", async () => {
  for (const session of [null, { ...ally, aliadoAccesoId: null }, { ...ally, aliadoAccesoId: 0 },
    { ...ally, aliadoAccesoId: -1 }, { ...ally, aliadoAccesoId: 7.1 },
    ...["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"].map(rolNombre => ({ ...central, rolNombre }))]) {
    const f = harness(session);
    await assert.rejects(() => f.render());
    assert.equal(f.calls.credits.length, 0);
    assert.equal(f.calls.evidence.length, 0);
    assert.equal(f.calls.management.length, 0);
    assert.equal(f.calls.numbers.length, 0);
  }
});

test("portafolio vacío no consulta evidencia ni gestiones globales; importación válida sigue elegible", async () => {
  const empty = harness(ally, []);
  const tree = await empty.render();
  assert.equal(empty.calls.evidence.length, 0);
  assert.equal(empty.calls.management.length, 0);
  assert.equal(empty.calls.schema, 0);
  assert.equal(nodes(tree).find(node => node.props?.credits)?.props.credits.length, 0);
  const historical = credit(5, { estado: "GENERADO", contratoAceptadoAt: null, pagareAceptadoAt: null,
    fotoEntregaDataUrl: null, fotoRemisionDataUrl: null, equalityService: "IMPORTACION_MASIVA",
    contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } });
  const f = harness(ally, [historical, credit(6, { ...historical, id: 6, equalityService: null })]);
  const importedTree = await f.render();
  assert.deepEqual(f.calls.numbers, [[5]]);
  assert.equal(nodes(importedTree).find(node => node.props?.credits)?.props.credits.length, 1);
});

test("payload sin dinero conserva filtros, unidades, porcentajes y días de referencia exactamente", () => {
  const rows = [
    { id: 1, folio: "1", cliente: "A", marca: "Apple", referencia: "iPhone 13", tipo: "IPHONE",
      aliado: "Aliado 7", sede: "Centro", fecha: "2026-10-01", capital: 500, saldo: 300, vencido: 100, dias: 15, gestion: null },
    { id: 2, folio: "2", cliente: "B", marca: "Apple", referencia: "iPhone 13", tipo: "IPHONE",
      aliado: "Aliado 7", sede: "Centro", fecha: "2026-09-01", capital: 500, saldo: 0, vencido: 0, dias: 0, gestion: null },
    { id: 3, folio: "3", cliente: "C", marca: "Apple", referencia: "iPhone 13", tipo: "IPHONE",
      aliado: "Aliado 7", sede: "Norte", fecha: "2026-10-02", capital: 500, saldo: 200, vencido: 0, dias: 0, gestion: null },
  ];
  const publicRows = risk.projectProductRiskCredits(rows);
  assert.doesNotMatch(JSON.stringify(publicRows), /"capital"|"saldo"|"vencido"/);
  for (const filter of [{}, ...["activo", "pagado", "mora", "alDia"].map(estado => ({ estado })),
    { desde: "2026-10-01", hasta: "2026-10-02", sede: "Centro", minDias: "10", maxDias: "20" }]) {
    const filters = { ...risk.emptyProductRiskFilters, ...filter };
    const original = risk.filterRiskCredits(rows, filters);
    const redacted = risk.filterRiskCredits(publicRows, filters);
    assert.deepEqual(redacted.map(row => row.id), original.map(row => row.id));
    const nonFinancial = data => risk.aggregateProductRisk(data).map(row => Object.fromEntries(
      Object.entries(row).filter(([key]) => !["capital", "saldo", "vencido", "credits"].includes(key))));
    assert.deepEqual(nonFinancial(redacted), nonFinancial(original));
    for (const group of risk.aggregateProductRisk(redacted)) {
      assert.equal(group.capital, 0); assert.equal(group.saldo, 0); assert.equal(group.vencido, 0);
    }
  }
  const centralRows = risk.projectProductRiskCredits(rows, { viewingCentral: true });
  assert.equal(centralRows[0].capital, rows[0].capital);
  assert.equal(centralRows[0].saldo, rows[0].saldo);
  assert.equal(centralRows[0].vencido, rows[0].vencido);
  assert.equal(risk.riskCreditActive({ ...rows[0], activo: false }), false);
  assert.equal(risk.riskCreditActive({ ...rows[1], activo: true }), true);
});
