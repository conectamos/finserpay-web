import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}, globals = {}, extra = "") {
  const source = readFileSync(new URL("../" + file, import.meta.url), "utf8") + extra;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, URL, Request, Response, Date, Blob, console, ...globals,
    require(name) { assert.ok(name in dependencies, "Unexpected dependency: " + name); return dependencies[name]; },
  }, { filename: file });
  return loaded.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const display = load("lib/credit-display-number.ts");
const roles = load("lib/roles.ts");
const dates = load("lib/colombia-date.ts");
const factory = load("lib/credit-factory.ts", { "@/lib/colombia-date": dates });
const site = { id: 10, nombre: "Sede QA", codigo: "QA", aliadoId: 5, aliado: { nombre: "Aliado QA", codigo: "ALIADO" } };
const user = { id: 1, nombre: "Admin aliado", rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoAccesoId: 5, sedeId: 10 };
const credit = { id: 31, folio: "FC-ORIGINAL-31", clienteNombre: "Cliente QA", clienteDocumento: "00100031", montoCredito: 1000, cuotaInicial: 200, estado: "INSCRITO", sedeId: 10 };
const payment = { id: 11, credito: credit, valor: 100, metodoPago: "EFECTIVO", observacion: "", estado: "ACTIVO", fechaAbono: new Date("2026-09-17T12:00:00Z"), usuario: { id: 1, nombre: "Recaudador QA", usuario: "qa" }, vendedor: null, sede: site };

test("abonos devuelve número confirmado y busca dentro del aliado autorizado sin cambiar folio o montos", async () => {
  const calls = [];
  const database = {
    credito: { findMany: async query => { calls.push(["credits", plain(query)]); return [credit]; } },
    creditoAbono: {
      findMany: async query => { calls.push(["payments", plain(query)]); return [payment]; },
      groupBy: async () => [{ creditoId: 31, _sum: { valor: 100 }, _count: { _all: 1 } }],
    },
    creditSadminRegistration: { findMany: async query => {
      calls.push(["numbers", plain(query)]);
      return [{ creditoId: 31, numeroCredito: "000031-A", numeroCreditoConfirmado: true }];
    } },
  };
  const displayServer = load("lib/credit-display-number-server.ts", { "server-only": {}, "@/lib/prisma": { default: database }, "@/lib/credit-display-number": display });
  const route = load("app/api/reportes/abonos-credito/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/prisma": { default: database },
    "@/lib/auth": { getSessionUser: async () => user }, "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/roles": roles, "@/lib/aliados": { isFinserPayCentralAlly: () => false },
    "@/lib/credit-factory": factory, "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-display-number-server": displayServer,
    "@/lib/digital-collection-sede": { DIGITAL_COLLECTION_SEDE_CODE: "RECAUDO_DIGITAL", DIGITAL_COLLECTION_SEDE_NAME: "RECAUDO DIGITAL FINSER PAY" },
  });
  const response = await route.GET(new Request("https://finserpay.test/api/reportes/abonos-credito?search=000031-A&aliadoId=99"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].credito.id, 31);
  assert.equal(body.items[0].credito.folio, "FC-ORIGINAL-31");
  assert.equal(body.items[0].credito.numeroCreditoVisible, "000031-A");
  assert.equal(body.items[0].valor, 100);
  assert.equal(body.summary.totalRecaudadoPeriodo, 100);
  assert.equal(credit.numeroCreditoVisible, undefined);
  const creditQuery = calls.find(([name]) => name === "credits")[1];
  const paymentsQuery = calls.find(([name]) => name === "payments")[1];
  for (const query of [creditQuery, paymentsQuery]) assert.deepEqual(query.where.sede, { aliadoId: 5 });
  assert.deepEqual(creditQuery.where.OR.find(condition => condition.OR), plain(displayServer.creditNumberSearchWhere("000031-A")));
  assert.deepEqual(paymentsQuery.where.OR.find(condition => condition.credito?.OR), { credito: plain(displayServer.creditNumberSearchWhere("000031-A")) });
  assert.deepEqual(calls.find(([name]) => name === "numbers")[1].where,
    { creditoId: { in: [31] }, numeroCreditoConfirmado: true, numeroCredito: { not: null } });
});

test("el Excel de abonos conserva el número SADMIN como texto y exporta también el folio original", async () => {
  let exported;
  const anchor = { click() {}, remove() {} };
  const ui = load("app/dashboard/reportes/abonos/reporte-abonos-client.tsx", {
    "next/link": { default: () => null }, "react": {}, "react/jsx-runtime": {}, "@/lib/credit-display-number": display,
  }, {
    URL: { createObjectURL: blob => { exported = blob; return "blob:test"; }, revokeObjectURL() {} },
    document: { createElement: () => anchor, body: { appendChild() {} } },
  }, "\nexport { exportPaymentsToExcel };\n");
  const row = { ...payment, fechaAbono: payment.fechaAbono.toISOString(), credito: { ...credit, numeroCreditoVisible: "000031-A" } };
  ui.exportPaymentsToExcel([row], []);
  const html = await exported.text();
  assert.match(html, /<th>Número crédito<\/th><th>Folio original<\/th>/);
  assert.match(html, /mso-number-format:"\\@";'\>000031-A<\/td>/);
  assert.match(html, /mso-number-format:"\\@";'\>FC-ORIGINAL-31<\/td>/);
  assert.match(html, /<td>100<\/td>/);
  assert.equal(row.credito.folio, "FC-ORIGINAL-31");
});
