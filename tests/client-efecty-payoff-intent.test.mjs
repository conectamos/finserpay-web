import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("../", import.meta.url).pathname },
});
const payoffModule = await jiti.import("../lib/credit-early-payoff.ts");

function load(sourcePath, dependencies) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(output, {
    module: testModule,
    exports: testModule.exports,
    Date,
    console,
    require(name) {
      assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
      return dependencies[name];
    },
  });
  return testModule.exports;
}

function makeCredit(overrides = {}) {
  return {
    id: 42,
    clienteDocumento: "12345678",
    contratoSnapshot: null,
    saldoBaseFinanciado: 1_000_000,
    planCapitalVigente: null,
    montoCredito: 1_200_000,
    valorInteres: 100_000,
    valorFianza: 100_000,
    valorCuota: 100_000,
    plazoMeses: 12,
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: new Date("2030-10-01T17:00:00.000Z"),
    fechaProximoPago: new Date("2030-10-01T17:00:00.000Z"),
    pazYSalvoEmitidoAt: null,
    ...overrides,
  };
}

function makeRouteHarness(credit = makeCredit()) {
  const calls = [];
  const source = structuredClone(credit);
  const tx = {
    $queryRaw: async () => [{ id: 42 }],
    credito: {
      findFirst: async (input) => {
        calls.push({ action: "findCredit", input });
        return input.where.id === source.id && input.where.clienteDocumento === source.clienteDocumento
          ? source : null;
      },
    },
    creditoAbono: {
      findMany: async () => [],
    },
  };
  const prisma = { $transaction: (callback) => callback(tx) };
  const { POST } = load("../app/api/clientes/efecty-liquidacion/route.ts", {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-early-payoff": payoffModule,
    "@/lib/credit-factory": { sanitizeSearch: (value) => String(value || ""), toNumber: Number },
    "@/lib/efecty-payoff-intents": {
      ensureEfectyPayoffIntentTable: async () => {},
      createEfectyPayoffIntent: async (_client, input) => {
        calls.push({ action: "createIntent", input });
        return {
          id: 1,
          referencia: input.referencia,
          amountInCents: input.amountInCents,
          expiresAt: new Date("2030-10-01T23:00:00.000Z"),
        };
      },
    },
    "@/lib/prisma": prisma,
  });
  const request = (body) => ({ json: async () => body });
  return { POST, calls, credit: source, request };
}

test("Efecty prepares the actual payoff under credit lock without recording a payment", async () => {
  const fixture = makeRouteHarness();
  const before = structuredClone(fixture.credit);
  const result = await fixture.POST(fixture.request({ creditoId: 42, documento: "12345678" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.convenio, "113950");
  assert.equal(result.body.referencia, "12345678");
  assert.equal(result.body.amount, 1_000_000);
  assert.equal(fixture.calls[0].action, "findCredit");
  assert.equal(fixture.calls[0].input.where.id, 42);
  assert.equal(fixture.calls[0].input.where.clienteDocumento, "12345678");
  assert.equal(fixture.calls[1].action, "createIntent");
  assert.equal(fixture.calls[1].input.amountInCents, 100_000_000);
  assert.equal(fixture.calls[1].input.quote.capitalPendiente, 1_000_000);
  assert.equal(fixture.calls[1].input.quote.saldoObligacion, 1_200_000);
  assert.equal(fixture.calls.length, 2, "No se escribe abono, caja ni estado de crédito");
  assert.deepEqual(fixture.credit, before);
});

test("Efecty does not issue a payoff intent for a different document or settled credit", async () => {
  const different = makeRouteHarness();
  const mismatch = await different.POST(different.request({ creditoId: 42, documento: "87654321" }));
  assert.equal(mismatch.status, 404);
  assert.equal(different.calls.some((call) => call.action === "createIntent"), false);

  const settled = makeRouteHarness(makeCredit({ pazYSalvoEmitidoAt: new Date() }));
  const closed = await settled.POST(settled.request({ creditoId: 42, documento: "12345678" }));
  assert.equal(closed.status, 409);
  assert.equal(settled.calls.some((call) => call.action === "createIntent"), false);
});

test("one confirmed Efecty collection can consume the quote only once", async () => {
  const rows = [];
  const createdTables = [];
  const client = {
    $executeRaw: async (parts) => { createdTables.push(parts.join("")); return 0; },
    $queryRaw: async (parts, ...values) => {
      const sql = parts.join("?");
      if (sql.includes("INSERT INTO")) {
        const row = {
          id: rows.length + 1,
          creditoId: values[0], referencia: values[1], amountInCents: values[2],
          quote: JSON.parse(values[3]), createdAt: values[4], expiresAt: values[5],
          consumedAt: null, paymentKey: null,
        };
        rows.push(row);
        return [row];
      }
      if (sql.trimStart().startsWith("UPDATE")) {
        const row = rows.find((item) => item.id === values[1] && !item.consumedAt);
        if (!row) return [];
        row.paymentKey = values[0];
        row.consumedAt = new Date();
        return [{ id: row.id }];
      }
      if (sql.includes('"quote" = CAST')) {
        return rows.filter((item) => item.creditoId === values[0] &&
          item.referencia === values[1] && item.amountInCents === values[2] &&
          JSON.stringify(item.quote) === values[3] && !item.consumedAt &&
          item.expiresAt > values[4]);
      }
      return rows.filter((item) => item.creditoId === values[0] &&
        item.referencia === values[1] && item.amountInCents === values[2] &&
        item.createdAt <= values[3] && item.expiresAt >= values[3] && !item.consumedAt);
    },
  };
  const intents = load("../lib/efecty-payoff-intents.ts", {
    "@/lib/credit-early-payoff": payoffModule,
    "@/lib/prisma": client,
  });
  await intents.ensureEfectyPayoffIntentTable();
  assert.equal(createdTables.length, 3);
  const quotedAt = new Date("2026-09-27T14:00:00.000Z");
  const quote = {
    tipo: "LIQUIDACION_ANTICIPADA", capitalPendiente: 1000,
    condonacion: 150, montoCreditoLiquidado: 3000, saldoObligacion: 1150,
  };
  const input = { creditoId: 42, referencia: "12.345.678", amountInCents: 100_000, quote, now: quotedAt };
  const first = await intents.createEfectyPayoffIntent(client, input);
  const repeat = await intents.createEfectyPayoffIntent(client, input);
  assert.equal(first.id, repeat.id);
  assert.equal(rows.length, 1);
  assert.equal(first.referencia, "12345678");
  assert.equal(first.expiresAt.getTime() - quotedAt.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(await intents.findEfectyPayoffIntent(client, {
    creditoId: 42, referencia: "12345678", amountInCents: 100_000,
    paidAt: new Date("2026-09-27T18:00:00.000Z"),
  })?.then((item) => item?.id), first.id);
  assert.equal(await intents.findEfectyPayoffIntent(client, {
    creditoId: 42, referencia: "12345678", amountInCents: 99_999,
    paidAt: new Date("2026-09-27T18:00:00.000Z"),
  }), null);
  assert.equal(await intents.findEfectyPayoffIntent(client, {
    creditoId: 42, referencia: "87654321", amountInCents: 100_000,
    paidAt: new Date("2026-09-27T18:00:00.000Z"),
  }), null);
  assert.equal(await intents.findEfectyPayoffIntent(client, {
    creditoId: 42, referencia: "12345678", amountInCents: 100_000,
    paidAt: new Date("2026-09-27T13:59:59.000Z"),
  }), null);
  assert.equal(await intents.findEfectyPayoffIntent(client, {
    creditoId: 42, referencia: "12345678", amountInCents: 100_000,
    paidAt: new Date("2026-09-28T14:00:01.000Z"),
  }), null);
  assert.equal(await intents.consumeEfectyPayoffIntent(client, first.id, "efecty-confirmed-1"), true);
  assert.equal(await intents.consumeEfectyPayoffIntent(client, first.id, "efecty-confirmed-1"), false);
  assert.equal(await intents.findEfectyPayoffIntent(client, {
    creditoId: 42, referencia: "12345678", amountInCents: 100_000,
    paidAt: new Date("2026-09-27T18:00:00.000Z"),
  }), null);
});
