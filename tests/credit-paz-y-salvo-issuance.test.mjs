import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const factory = await jiti.import("../lib/credit-factory.ts");
const issuedAt = new Date("2026-10-11T15:24:00Z");
const paths = {
  client: "app/api/clientes/creditos/[id]/paz-y-salvo/route.ts",
  admin: "app/api/creditos/[id]/paz-y-salvo/route.ts",
};

function harness(audience, options = {}) {
  const trace = { renders: [], updates: [], aggregates: [], locks: [], transactions: 0, paymentIntentReads: 0 };
  const document = "99112233";
  const credit = {
    id: 42, folio: "FC-CERTIFICADO-REAL-QA", clienteDocumento: document,
    clienteNombre: "CLIENTE DE PRUEBA CERTIFICADO", cuotaInicial: 50_000,
    montoCredito: options.montoCredito ?? 300_000,
    pazYSalvoEmitidoAt: options.previouslyIssued ? issuedAt : null,
    estado: options.estado || "APROBADO", referenciaEquipo: "EQUIPO DE PRUEBA 128GB",
    imei: "123456789012345", deviceUid: "DEVICE-PRUEBA", deliverableLabel: "Pendiente de verificación técnica",
    referenciaPago: "REF-CERTIFICADO-QA", sede: { nombre: "SEDE DE PRUEBA" },
  };
  const payments = options.payments ?? [{ valor: 100_000, estado: "ACTIVO" }, { valor: 200_000, estado: "ACTIVO" }];
  let storedIssuedAt = credit.pazYSalvoEmitidoAt;
  const tx = {
    $queryRaw: async (strings, ...values) => {
      trace.locks.push({ sql: strings.join("?"), values });
      const matched = options.found !== false && (audience !== "client" || values[1] === document);
      return matched ? [{ id: credit.id }] : [];
    },
    credito: {
      findFirst: async args => {
        if (Object.keys(args.select || {}).length === 1 && args.select.pazYSalvoEmitidoAt) {
          return { pazYSalvoEmitidoAt: options.confirmIssue === false ? null : storedIssuedAt };
        }
        return options.found === false ? null : credit;
      },
      findUnique: async () => ({ pazYSalvoEmitidoAt: options.confirmIssue === false ? null : storedIssuedAt }),
      updateMany: async args => {
        trace.updates.push(args);
        if (!storedIssuedAt) storedIssuedAt = args.data.pazYSalvoEmitidoAt;
        return { count: credit.pazYSalvoEmitidoAt ? 0 : 1 };
      },
    },
    creditoAbono: {
      aggregate: async args => {
        trace.aggregates.push(args);
        assert.equal(args.where.estado.not, "ANULADO", "cancelled payments never discharge the obligation");
        const active = payments.filter(payment => payment.estado !== args.where.estado.not);
        return { _sum: { valor: active.reduce((total, payment) => total + payment.valor, 0) }, _count: { _all: active.length } };
      },
    },
    wompiPaymentIntent: {
      findFirst: async () => { trace.paymentIntentReads++; throw new Error("Provider status is not a registered payment"); },
    },
  };
  const prisma = {
    credito: { findFirst: async () => options.found === false ? null : { id: credit.id } },
    $transaction: async callback => { trace.transactions++; return callback(tx); },
  };
  const mocks = {
    "next/server": { NextResponse: Response },
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-factory": factory,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map([[credit.id, "000-CERT-42"]]) },
    "@/lib/credit-paz-y-salvo-pdf": {
      buildCreditPazYSalvoPdf: async input => { trace.renders.push(input); return Buffer.from("%PDF-CERTIFICATE-GUARD-TEST"); },
      getCreditPazYSalvoPdfErrorCode: () => null,
    },
    "@/lib/auth": { getSessionUser: async () => options.authenticated === false ? null : { rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", nombre: "ADMIN DE PRUEBA", usuario: "admin-prueba" } },
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/credit-route-lookup": {
      parseCreditRouteLookup: value => ({ id: Number(value) }),
      buildCreditLookupWhere: value => ({ id: value.id }),
      buildCreditAccessWhere: () => ({}),
    },
  };
  const source = readFileSync(new URL(`../${paths[audience]}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports,
    require: name => { if (!(name in mocks)) throw new Error(`Unexpected route import ${name}`); return mocks[name]; },
    console: { error() {} }, Buffer, Date, Number, String, Math, URL, Uint8Array,
  });
  return {
    trace, credit,
    request: () => loaded.exports.GET(new Request(`https://example.test/api/${audience === "client" ? "clientes/" : ""}creditos/42/paz-y-salvo?documento=${options.requestDocument || document}`), { params: Promise.resolve({ id: "42" }) }),
  };
}

for (const audience of ["client", "admin"]) {
  test(`${audience}: a real unpaid balance blocks issuance even if a paid status or previous certificate exists`, async () => {
    for (const pending of [0.55, 1, 25_000]) {
      const h = harness(audience, { montoCredito: 300_000 + pending, previouslyIssued: true, estado: "PAZ_Y_SALVO" });
      const response = await h.request();
      assert.equal(response.status, audience === "client" ? 409 : 400);
      assert.match((await response.json()).error, /saldo pendiente/i);
      assert.equal(h.trace.renders.length, 0);
      assert.equal(h.trace.updates.length, 0);
      assert.ok(h.trace.locks[0].sql.includes("FOR UPDATE"));
    }
  });

  test(`${audience}: an approved provider request without an applied payment cannot produce a certificate`, async () => {
    const h = harness(audience, { payments: [], estado: "PAGADO" });
    const response = await h.request();
    assert.equal(response.status, audience === "client" ? 409 : 400);
    assert.equal(h.trace.paymentIntentReads, 0);
    assert.equal(h.trace.renders.length, 0);
    assert.equal(h.trace.updates.length, 0);
  });

  test(`${audience}: cancelled payments and a down payment do not replace the active credit collections`, async () => {
    const h = harness(audience, { payments: [{ valor: 250_000, estado: "ACTIVO" }, { valor: 50_000, estado: "ANULADO" }] });
    const response = await h.request();
    assert.equal(response.status, audience === "client" ? 409 : 400);
    assert.equal(h.trace.renders.length, 0);
    assert.equal(h.trace.updates.length, 0);
  });

  test(`${audience}: zero balance issues the certificate using the confirmed timestamp and original identities`, async () => {
    const h = harness(audience, { previouslyIssued: true });
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    assert.match(response.headers.get("Content-Disposition"), /FC-CERTIFICADO-REAL-QA/);
    assert.equal(h.trace.renders.length, 1);
    const pdf = h.trace.renders[0];
    assert.equal(pdf.folio, h.credit.folio);
    assert.equal(pdf.numeroCreditoVisible, "000-CERT-42");
    assert.equal(pdf.clienteDocumento, h.credit.clienteDocumento);
    assert.equal(pdf.clienteNombre, h.credit.clienteNombre);
    assert.equal(pdf.equipo, h.credit.referenciaEquipo);
    assert.equal(pdf.imei, h.credit.imei);
    assert.equal(pdf.deviceUid, h.credit.deviceUid);
    assert.equal(pdf.deliverableLabel, h.credit.deliverableLabel);
    assert.equal(pdf.estado, "PAZ_Y_SALVO");
    assert.equal(pdf.issuedAt.toISOString(), issuedAt.toISOString());
    assert.ok(h.trace.updates.every(update => update.where.pazYSalvoEmitidoAt === null));
  });

  test(`${audience}: a newly settled credit renders only after the persisted issue timestamp is confirmed`, async () => {
    const h = harness(audience);
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.equal(h.trace.updates.length, 1);
    assert.equal(h.trace.renders.length, 1);
    assert.equal(h.trace.renders[0].issuedAt.toISOString(), h.trace.updates[0].data.pazYSalvoEmitidoAt.toISOString());
    assert.ok(Number.isFinite(h.trace.renders[0].issuedAt.getTime()));
  });

  test(`${audience}: a missing confirmation of issuance does not render a PDF`, async () => {
    const h = harness(audience, { confirmIssue: false });
    const response = await h.request();
    assert.equal(response.status, 409);
    assert.equal(h.trace.renders.length, 0);
  });

  test(`${audience}: no matching credit produces no financial updates or PDF`, async () => {
    const h = harness(audience, { found: false });
    const response = await h.request();
    assert.equal(response.status, 404);
    assert.equal(h.trace.renders.length, 0);
    assert.equal(h.trace.updates.length, 0);
  });
}

test("client: the customer's document remains part of the locked lookup", async () => {
  const h = harness("client", { requestDocument: "99112234" });
  const response = await h.request();
  assert.equal(response.status, 404);
  assert.equal(h.trace.renders.length, 0);
  assert.equal(h.trace.locks[0].values[1], "99112234");
});

test("admin: anonymous requests never access or render a certificate", async () => {
  const h = harness("admin", { authenticated: false });
  const response = await h.request();
  assert.equal(response.status, 401);
  assert.equal(h.trace.transactions, 0);
  assert.equal(h.trace.renders.length, 0);
});