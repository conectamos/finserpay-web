import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

function functionsFrom(path, names, globals = {}, prelude = "") {
  const sourceText = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
  const declarations = names.map((name) => {
    const found = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
    );
    assert.ok(found, `Missing function ${name}`);
    return found.getText(source).replace(/^export\s+/, "");
  });
  const { outputText } = ts.transpileModule(
    `${prelude}\n${declarations.join("\n")}\nexports.result = { ${names.join(",")} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  );
  const exports = {};
  runInNewContext(outputText, { exports, console, Date, URL, Map, ...globals }, { filename: path });
  return exports.result;
}

function credit(id) {
  return {
    id,
    folio: `FC-${id}`,
    clienteNombre: "Cliente de prueba",
    clienteDocumento: "1234567890",
    fechaCredito: new Date("2026-09-01T12:00:00.000Z"),
    montoCredito: id,
    valorCuota: 100,
    plazoMeses: 3,
    sede: { nombre: "Sede" },
    abonos: [],
  };
}

function clientApi({ statuses, exemption, creditExceptions = new Map() }) {
  const calls = { agreements: [], creditExceptions: [], creditQueries: [] };
  const NextResponse = {
    json: (body, options = {}) => ({ body, status: options.status ?? 200 }),
  };
  const { GET } = functionsFrom("app/api/clientes/creditos/route.ts", ["GET"], {
    NextResponse,
    sanitizeSearch: (value) => String(value || "").trim(),
    ensureCreditAbonoAuditColumns: async () => {},
    prisma: {
      credito: {
        findMany: async (query) => {
          calls.creditQueries.push(query);
          return statuses.map((_, index) => credit(index + 1));
        },
      },
    },
    getCreditDisplayNumbers: async () => new Map(),
    withCreditDisplayNumber: (item) => ({ ...item, numeroCreditoVisible: item.folio }),
    buildCreditPaymentPlan: ({ montoCredito }) => ({
      estadoPago: statuses[montoCredito - 1],
      saldoPendiente: montoCredito * 100,
      totalPaid: 0,
      installments: [{ numero: 1, saldoPendiente: montoCredito * 100 }],
    }),
    calculateCreditEarlyPayoff: () => ({
      eligible: false,
      reason: "No disponible",
      capitalPendiente: 100,
      interesFianzaCondonado: 0,
      saldoObligacion: 100,
    }),
    readMassCreditComponents: () => null,
    getActiveMoraBlockExemptionByDocument: async (documento) => {
      calls.agreements.push(documento);
      return exemption;
    },
    getActiveMoraExceptionsByCreditIds: async (ids) => {
      calls.creditExceptions.push([...ids]);
      return creditExceptions;
    },
  });
  return { GET, calls };
}

const request = () => new Request("https://example.test/api/clientes/creditos?documento=1234567890");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("el cliente conserva la mora y muestra la fecha real solo en créditos vencidos con acuerdo", async () => {
  const hasta = "2026-10-10T23:59:59.999Z";
  const { GET, calls } = clientApi({
    statuses: ["MORA", "AL_DIA", "PAGADO"],
    exemption: { fechaFin: new Date(hasta), motivo: "Privado", documento: "1234567890" },
  });
  const response = await GET(request());
  const items = plain(response.body.items);

  assert.equal(response.status, 200);
  assert.deepEqual(calls.agreements, ["1234567890"]);
  assert.deepEqual(items.map((item) => item.estadoPago), ["MORA", "AL_DIA", "PAGADO"]);
  assert.deepEqual(items.map((item) => item.saldoPendiente), [100, 200, 300]);
  assert.deepEqual(items.map((item) => item.prorrogaMora), [{ hasta }, null, null]);
  assert.equal("motivo" in items[0], false);
  assert.equal("documento" in items[0].prorrogaMora, false);
});

test("la excepción nueva se limita al crédito aprobado aunque comparta cédula", async () => {
  const hasta = new Date("2026-10-21T23:59:59.999-05:00");
  const { GET, calls } = clientApi({
    statuses: ["MORA", "MORA"],
    exemption: null,
    creditExceptions: new Map([[2, { fechaFin: hasta, type: "PRORROGA" }]]),
  });
  const response = await GET(request());

  assert.deepEqual(plain(response.body.items.map((item) => item.prorrogaMora)), [
    null,
    { hasta: hasta.toISOString() },
  ]);
  assert.deepEqual(calls.creditExceptions, [[1, 2]]);
});

test("un acuerdo vigente sin fecha final conserva hasta nulo", async () => {
  const { GET } = clientApi({ statuses: ["MORA"], exemption: { fechaFin: null } });
  const response = await GET(request());
  assert.deepEqual(plain(response.body.items[0].prorrogaMora), { hasta: null });
});

test("sin acuerdo activo o sin mora no se anuncia prórroga", async () => {
  const overdue = clientApi({ statuses: ["MORA"], exemption: null });
  const current = clientApi({ statuses: ["AL_DIA"], exemption: { fechaFin: new Date("2026-10-10T23:59:59.999Z") } });
  const overdueResponse = await overdue.GET(request());
  const currentResponse = await current.GET(request());

  assert.equal(overdueResponse.body.items[0].prorrogaMora, null);
  assert.equal(currentResponse.body.items[0].prorrogaMora, null);
  assert.deepEqual(overdue.calls.agreements, ["1234567890"]);
  assert.deepEqual(current.calls.agreements, []);
});

test("la consulta compartida usa cédula normalizada y descarta acuerdos inactivos o vencidos", async () => {
  const database = new PGlite();
  const prisma = {
    $executeRawUnsafe: (sql) => database.query(sql),
    $queryRaw: async (parts, ...values) => {
      const sql = parts.reduce(
        (text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ""),
        ""
      );
      return (await database.query(sql, values)).rows;
    },
  };
  const {
    getActiveMoraBlockExemptionByDocument,
  } = functionsFrom(
    "lib/mora-block-exemptions.ts",
    ["normalizeMoraExemptionDocument", "ensureMoraBlockExemptionTable", "getActiveMoraBlockExemptionByDocument"],
    { prisma },
    "let moraBlockExemptionsReady = false;"
  );

  try {
    await database.query(`
      CREATE TABLE "ExcepcionBloqueoMora" (
        id SERIAL PRIMARY KEY,
        documento TEXT NOT NULL UNIQUE,
        motivo TEXT NOT NULL,
        activa BOOLEAN NOT NULL,
        "fechaFin" TIMESTAMP(3),
        "creadoPorUsuarioId" INTEGER,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await database.query(`
      INSERT INTO "ExcepcionBloqueoMora" (documento, motivo, activa, "fechaFin") VALUES
        ('1234567890', 'Vigente', TRUE, '2026-10-10 23:59:59'),
        ('2222222222', 'Sin fecha', TRUE, NULL),
        ('3333333333', 'Vencido', TRUE, '2026-09-30 23:59:59'),
        ('4444444444', 'Inactivo', FALSE, '2026-10-10 23:59:59')
    `);

    const at = new Date("2026-10-03T12:00:00.000Z");
    const active = await getActiveMoraBlockExemptionByDocument("1.234.567.890", at);
    assert.ok(active?.fechaFin);
    assert.deepEqual(Object.keys(active), ["fechaFin"]);
    assert.ok(await getActiveMoraBlockExemptionByDocument(
      "1234567890",
      new Date("2026-10-10T23:59:59.000Z")
    ));
    assert.equal(await getActiveMoraBlockExemptionByDocument(
      "1234567890",
      new Date("2026-10-10T23:59:59.001Z")
    ), null);
    assert.deepEqual(await getActiveMoraBlockExemptionByDocument("2222222222", at), { fechaFin: null });
    assert.equal(await getActiveMoraBlockExemptionByDocument("3333333333", at), null);
    assert.equal(await getActiveMoraBlockExemptionByDocument("4444444444", at), null);
    assert.equal(await getActiveMoraBlockExemptionByDocument("5555555555", at), null);
  } finally {
    await database.close();
  }
});
