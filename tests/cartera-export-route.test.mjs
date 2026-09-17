import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import ts from "typescript";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const carteraExport = await jiti.import("../lib/cartera-export.ts");
const displayNumber = await jiti.import("../lib/credit-display-number.ts");

function loadRoute(dependencies) {
  const routePath = "app/api/dashboard/cartera/export/route.ts";
  const source = readFileSync(path.join(projectRoot, routePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = { exports: {} };

  runInNewContext(
    outputText,
    {
      exports: loaded.exports,
      module: loaded,
      console,
      Date,
      Intl,
      Request,
      Response,
      URL,
      require(name) {
        assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
        return dependencies[name];
      },
    },
    { filename: routePath }
  );

  return loaded.exports;
}

function creditFixture(id, estado, changes = {}) {
  return {
    id,
    folio: `CARTERA-${id}`,
    clienteNombre: `CLIENTE_${estado}_${id}`,
    clienteDocumento: `10000000${id}`,
    clienteTelefono: `30000000${id}`,
    clienteDireccion: "Calle de prueba",
    clienteFechaNacimiento: new Date("1990-01-02T00:00:00.000Z"),
    clienteCorreo: `cliente${id}@example.test`,
    clienteGenero: "OTRO",
    imei: `0000000000000${id}`,
    referenciaEquipo: `EQUIPO-${id}`,
    equipoMarca: "MARCA",
    equipoModelo: "MODELO",
    valorEquipoTotal: 1_200_000,
    saldoBaseFinanciado: 1_000_000,
    montoCredito: 1_100_000,
    cuotaInicial: 200_000,
    plazoMeses: 12,
    frecuenciaPago: "MENSUAL",
    tasaInteresEa: 10,
    valorInteres: 100_000,
    fianzaPorcentaje: 10,
    valorFianza: 100_000,
    valorCuota: 100_000,
    fechaCredito: new Date("2026-09-01T15:00:00.000Z"),
    fechaPrimerPago: new Date("2026-10-01T15:00:00.000Z"),
    fechaProximoPago: new Date("2026-10-01T15:00:00.000Z"),
    estado,
    pazYSalvoEmitidoAt: null,
    contratoSnapshot: null,
    amortizacion: null,
    abonos: [],
    sede: {
      nombre: "SEDE PRUEBA",
      aliado: { nombre: "ALIADO PRUEBA" },
    },
    ...changes,
  };
}

function workbookRows(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(
    (match) => match[1]
  );
}

test("GET exporta cartera activa y pagada, excluye anulados y conserva tasas porcentuales numericas", async () => {
  const credits = [
    creditFixture(1, "INSCRITO", {
      clienteNombre: "CLIENTE_ACTIVO_EXPORTADO",
      amortizacion: {
        tasaInteresEaPorcentaje: 29.24,
        fianzaCuotaPorcentaje: 75 / 12,
        seguroCuotaPorcentaje: 0.03,
        numeroCuotas: 12,
      },
    }),
    creditFixture(2, "PAZ_Y_SALVO", {
      clienteNombre: "CLIENTE_PAGADO_EXPORTADO",
      pazYSalvoEmitidoAt: new Date("2026-09-15T15:00:00.000Z"),
      contratoSnapshot: {
        financiero: {
          tasaInteresEa: 25,
          fianzaTotalPorcentaje: 60,
          seguroCuotaPorcentaje: 0.05,
        },
      },
    }),
    creditFixture(3, "CANCELADO", {
      clienteNombre: "CLIENTE_CANCELADO_NO_EXPORTAR",
    }),
    creditFixture(4, "ANULADO", {
      clienteNombre: "CLIENTE_ANULADO_NO_EXPORTAR",
    }),
  ];
  let findManyQuery = null;
  const prisma = {
    credito: {
      async findMany(query) {
        findManyQuery = query;
        return credits;
      },
    },
  };
  const route = loadRoute({
    "next/server": { NextResponse: Response },
    "@/lib/credit-payment-plan": {
      buildCreditPaymentPlan(input) {
        const paid = Boolean(input.settled);
        const nextInstallment = paid
          ? null
          : {
              fechaVencimiento: "2026-10-01",
              saldoPendiente: 400_000,
              estaEnMora: false,
            };

        return {
          saldoPendiente: paid ? 0 : 400_000,
          installments: nextInstallment ? [nextInstallment] : [],
          nextInstallment,
          paidCount: paid ? 12 : 8,
          pendingCount: paid ? 0 : 4,
        };
      },
    },
    "@/lib/credit-outstanding-balance": {
      splitOutstandingBalance({ saldoPendiente }) {
        return {
          saldoCapital: saldoPendiente,
          saldoFianza: 0,
          saldoIntereses: 0,
        };
      },
    },
    "@/lib/credit-abono-audit": {
      ensureCreditAbonoAuditColumns: async () => {},
    },
    "@/lib/credit-factory": {
      getPaymentFrequencyLabel: (value) => String(value || ""),
      sanitizeText: (value) => String(value || ""),
    },
    "@/lib/auth": {
      getSessionUser: async () => ({
        id: 1,
        rolNombre: "ADMIN",
        aliadoAccesoCodigo: "FINSERPAY",
        aliadoAccesoId: 1,
      }),
    },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/cartera-export": carteraExport,
    "@/lib/credit-display-number": displayNumber,
    "@/lib/credit-display-number-server": {
      async getCreditDisplayNumbers(ids) {
        assert.deepEqual(Array.from(ids), [1, 2, 3, 4]);
        return new Map([[1, "000123-A"]]);
      },
      withCreditDisplayNumber: (credit, numbers) => ({ ...credit, numeroCreditoVisible: numbers.get(credit.id) || credit.folio }),
    },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/prisma": { default: prisma },
  });

  const response = await route.GET(
    new Request("https://finserpay.test/api/dashboard/cartera/export")
  );
  const html = await response.text();
  const rows = workbookRows(html);

  assert.equal(response.status, 200);
  assert.equal(rows.length, 2);
  assert.ok(findManyQuery);
  assert.match(html, /Interés mensual efectivo \(%\)/);
  assert.match(html, /Fianza total del crédito \(%\)/);
  assert.match(html, /Seguro por cuota \(%\)/);
  assert.match(html, /<th>Número crédito<\/th>/);
  assert.match(html, /<th>Folio original<\/th>/);

  const activeRow = rows.find((row) => row.includes("CLIENTE_ACTIVO_EXPORTADO"));
  const paidRow = rows.find((row) => row.includes("CLIENTE_PAGADO_EXPORTADO"));
  assert.ok(activeRow);
  assert.ok(paidRow);
  assert.match(activeRow, />000123-A<\/td>[\s\S]*>CARTERA-1<\/td>/);
  assert.match(paidRow, />CARTERA-2<\/td>[\s\S]*>CARTERA-2<\/td>/);
  assert.equal(credits[0].folio, "CARTERA-1");
  assert.equal(credits[0].numeroCreditoVisible, undefined);
  assert.doesNotMatch(html, /CLIENTE_CANCELADO_NO_EXPORTAR/);
  assert.doesNotMatch(html, /CLIENTE_ANULADO_NO_EXPORTAR/);

  assert.match(activeRow, />0\.021605<\/td>[\s\S]*>0\.75<\/td>[\s\S]*>0\.0003<\/td>/);
  assert.match(paidRow, />0\.018769<\/td>[\s\S]*>0\.6<\/td>[\s\S]*>0\.0005<\/td>/);
  assert.match(activeRow, /mso-number-format:"0\.0000%"/);
  assert.match(paidRow, />0<\/td>[\s\S]*>0<\/td>/);
});
