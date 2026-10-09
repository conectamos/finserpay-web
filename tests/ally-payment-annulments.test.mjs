import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadService() {
  const source = readFileSync(
    new URL("../lib/ally-payment-annulments.ts", import.meta.url),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(
    compiled,
    {
      module: loaded,
      exports: loaded.exports,
      Date,
      Number,
      String,
      Error,
      require(name) {
        assert.equal(name, "server-only");
        return {};
      },
    },
    { filename: "lib/ally-payment-annulments.ts" }
  );
  return loaded.exports;
}

const service = loadService();

test("los ajustes pendientes se arrastran sin limite inferior y se bloquean al confirmar", async () => {
  const calls = [];
  const database = {
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      return [
        {
          id: 91,
          creditoId: 91_001,
          aliadoId: 7,
          aliadoNombre: "Aliado QA",
          fechaAnulacion: new Date("2026-10-09T16:00:00.000Z"),
          fechaAnulacionFuente: "OBSERVACION_ADMIN",
          folio: "QA-ANULADO-001",
          clienteNombre: "Cliente QA",
          clienteDocumento: "0012345678",
          imei: "000000000000001",
          equipo: "Equipo QA",
          plataforma: "IPHONE",
          sedeId: 4,
          sedeNombre: "Sede QA",
          liquidacionOrigenId: 22,
          valorDescuento: "1125000.00",
          motivo: "Anulacion solicitada",
        },
      ];
    },
  };

  const result = await service.loadPendingAllyPaymentAnnulmentAdjustments(
    database,
    {
      allyId: 7,
      start: new Date("2026-10-09T05:00:00.000Z"),
      endExclusive: new Date("2026-10-11T05:00:00.000Z"),
      lock: true,
    }
  );

  assert.deepEqual(calls[0].values, [
    7,
    new Date("2026-10-11T05:00:00.000Z"),
  ]);
  assert.doesNotMatch(calls[0].sql, /"fechaAnulacion"\s*>=/);
  assert.match(calls[0].sql, /application\."id" IS NULL/);
  assert.match(calls[0].sql, /FOR UPDATE OF adjustment/);
  assert.equal(result[0].id, 91);
  assert.equal(result[0].ajusteId, 91);
  assert.equal(result[0].creditoId, 91_001);
  assert.equal(result[0].valorDescuento, 1_125_000);
  assert.equal(result[0].estado, "PENDIENTE_DESCUENTO");
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].aliado)), {
    id: 7,
    nombre: "Aliado QA",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].sede)), {
    id: 4,
    nombre: "Sede QA",
  });
});

test("la anulacion congela exactamente el valor historico pagado", async () => {
  const calls = [];
  const database = {
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes('FROM public."LiquidacionAliadoCredito"')) {
        return [
          {
            liquidacionCreditoOrigenId: 31,
            creditoId: 91_001,
            aliadoId: 7,
            aliadoNombre: "Aliado QA",
            liquidacionOrigenId: 22,
            estadoLiquidacion: "PAGADA",
            estadoCreditoPagado: "PAGADO",
            folio: "QA-ANULADO-001",
            clienteNombre: "Cliente QA",
            clienteDocumento: "0012345678",
            imei: "000000000000001",
            equipo: "Equipo QA",
            plataforma: "IPHONE",
            sedeId: 4,
            sedeNombre: "Sede QA",
            valorPagar: "1125000.00",
          },
        ];
      }
      if (sql.includes('INSERT INTO public."AjusteAnulacionCreditoAliado"')) {
        return [{ id: 91 }];
      }
      assert.fail("Consulta inesperada");
    },
  };

  const created = await service.registerPaidCreditAnnulmentAdjustment(database, {
    creditoId: 91_001,
    aliadoId: 7,
    fechaAnulacion: new Date("2026-10-09T16:00:00.000Z"),
    fechaAnulacionFuente: "OPERACION_EN_LINEA",
    motivo: "Anulacion solicitada",
    creadoPorUsuarioId: 3,
    creadoPorNombre: "Administrador QA",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(created)), { id: 91 });
  const insert = calls.find(call =>
    call.sql.includes('INSERT INTO public."AjusteAnulacionCreditoAliado"')
  );
  assert.ok(insert);
  assert.equal(insert.values[15], "1125000.00");
  assert.equal(insert.values[16], "Anulacion solicitada");
  assert.match(insert.sql, /ON CONFLICT \("creditoId"\) DO NOTHING/);
});

test("no registra descuento si el snapshot de origen no esta pagado", async () => {
  let inserts = 0;
  const database = {
    async $queryRawUnsafe(sql) {
      if (sql.includes('FROM public."LiquidacionAliadoCredito"')) {
        return [
          {
            liquidacionCreditoOrigenId: 31,
            creditoId: 55,
            aliadoId: 7,
            aliadoNombre: "Aliado QA",
            liquidacionOrigenId: 22,
            estadoLiquidacion: "PAGADA",
            estadoCreditoPagado: "ANULADO",
            valorPagar: "1125000.00",
          },
        ];
      }
      inserts += 1;
      return [];
    },
  };

  const result = await service.registerPaidCreditAnnulmentAdjustment(database, {
    creditoId: 55,
    aliadoId: 7,
    fechaAnulacion: new Date(),
    motivo: "QA",
    creadoPorUsuarioId: 3,
    creadoPorNombre: "Administrador QA",
  });
  assert.equal(result, null);
  assert.equal(inserts, 0);
});
