import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { resolveColombiaPaymentPeriod } from "../lib/ally-payments-core.ts";

const eligibilityModuleUrl = new URL("../lib/ally-payment-eligibility.ts", import.meta.url).href;
const eligibilityImports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === eligibilityModuleUrl && specifier === "./ally-payments-core") {
      return nextResolve("./ally-payments-core.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const {
  ALLY_PAYMENT_DATE_EXCEPTION,
  buildAllyPaymentEligibilityQuery,
} = await import(eligibilityModuleUrl);
eligibilityImports.deregister();

const authorizedException = {
  creditId: 189,
  allyId: 65588,
  originalDate: "2026-08-31T17:08:40.184Z",
  effectiveDate: "2026-09-01T05:00:00.000Z",
  reference: "ALLY_PAYMENT_20260908_C189",
};

function periodInput(startDate, endDate = startDate, allyId = 65588) {
  const period = resolveColombiaPaymentPeriod(startDate, endDate);
  return { allyId, start: period.start, endExclusive: period.endExclusive };
}

function fixtureCredit(overrides = {}) {
  return {
    id: 189,
    fechaCredito: authorizedException.originalDate,
    sedeId: 1,
    estado: "INSCRITO",
    clienteDocumento: "1062402825",
    plataforma: "ANDROID",
    ...overrides,
  };
}

// Each source table is a CTE backed by parameterized VALUES. No table, temporary
// table, or production row is created, read, changed, locked, or deleted.
function fixtureQuery(input, credits, paidCreditIds = []) {
  const eligibility = buildAllyPaymentEligibilityQuery(input);
  assert.equal(input.lock, undefined, "Los fixtures no deben bloquear tablas.");
  const values = [...eligibility.values];
  const parameter = (value, type) => {
    values.push(value);
    return `$${values.length}::${type}`;
  };
  const creditTuples = credits.map((credit) =>
    `(${[
      parameter(credit.id, "integer"),
      parameter(credit.fechaCredito, "timestamp"),
      parameter(credit.sedeId, "integer"),
      parameter(credit.estado, "text"),
      parameter(credit.clienteDocumento, "text"),
      parameter(credit.plataforma, "text"),
    ].join(", ")})`
  );
  const paidTuples = paidCreditIds.length
    ? paidCreditIds.map((creditId, index) =>
        `(${parameter(index + 1, "integer")}, ${parameter(creditId, "integer")})`
      )
    : ["(NULL::integer, NULL::integer)"];

  assert.ok(creditTuples.length > 0, "El fixture necesita al menos un credito.");

  return {
    text: `WITH
      "Credito" AS (
        SELECT fixture."id", fixture."fechaCredito", fixture."sedeId",
          fixture."estado", fixture."clienteDocumento",
          'FOLIO-TEST'::text AS "folio",
          'Cliente sintetico'::text AS "clienteNombre",
          'IMEI-TEST'::text AS "imei", 'DEVICE-TEST'::text AS "deviceUid",
          'Equipo sintetico'::text AS "referenciaEquipo",
          CASE WHEN fixture."plataforma" = 'IPHONE' THEN 'Apple' ELSE 'Samsung' END AS "equipoMarca",
          'Modelo sintetico'::text AS "equipoModelo",
          1000000::numeric AS "valorEquipoTotal", 200000::numeric AS "cuotaInicial",
          jsonb_build_object('equipo', jsonb_build_object('plataforma', fixture."plataforma")) AS "contratoSnapshot"
        FROM (VALUES ${creditTuples.join(", ")}) AS fixture(
          "id", "fechaCredito", "sedeId", "estado", "clienteDocumento", "plataforma"
        )
      ),
      "Sede" ("id", "aliadoId") AS (
        VALUES (1::integer, 65588::integer), (2::integer, 65589::integer),
          (3::integer, 1::integer)
      ),
      "Aliado" AS (
        SELECT fixture.*, 10::numeric AS "redescuentoPorcentaje",
          10::numeric AS "redescuentoAndroidPorcentaje",
          15::numeric AS "redescuentoIphonePorcentaje"
        FROM (VALUES
          (65588::integer, 'ALIADO-TEST'::text, 'Aliado sintetico'::text),
          (65589::integer, 'OTRO-ALIADO'::text, 'Otro aliado sintetico'::text),
          (1::integer, 'FINSERPAY'::text, 'Central sintetica'::text)
        ) AS fixture("id", "codigo", "nombre")
      ),
      "LiquidacionAliadoCredito" AS (
        SELECT fixture.* FROM (VALUES ${paidTuples.join(", ")})
          AS fixture("id", "creditoId") WHERE fixture."id" IS NOT NULL
      )
      ${eligibility.query}`,
    values,
  };
}

test("la excepcion identifica un solo credito y el instante Colombia autorizado", () => {
  assert.deepEqual(ALLY_PAYMENT_DATE_EXCEPTION, authorizedException);
  assert.equal(
    new Date(ALLY_PAYMENT_DATE_EXCEPTION.effectiveDate).toISOString(),
    periodInput("2026-09-01").start.toISOString()
  );
});

test("la misma consulta elegible admite el bloqueo transaccional sin cambiar parametros", () => {
  const input = periodInput("2026-09-01", "2026-09-05");
  const preview = buildAllyPaymentEligibilityQuery(input);
  const payment = buildAllyPaymentEligibilityQuery({ ...input, lock: true });

  assert.deepEqual(payment.values, preview.values);
  assert.equal(
    payment.query.trim(),
    `${preview.query.trim()} FOR UPDATE OF credit`
  );
  assert.equal(preview.values.includes(input.allyId), true);
  const serializedValues = preview.values.map((value) =>
    value instanceof Date ? value.toISOString() : value
  );
  assert.equal(
    serializedValues.includes(input.start.toISOString()),
    true
  );
  assert.equal(
    serializedValues.includes(input.endExclusive.toISOString()),
    true
  );
});

test("SQL real: excepcion puntual, fechas historicas, permisos y pendientes", {
  skip: process.env.ALLY_PAYMENT_TEST_DATABASE_URL
    ? false
    : "Falta ALLY_PAYMENT_TEST_DATABASE_URL; integracion PostgreSQL no ejecutada.",
}, async (t) => {
  const imported = await import("pg");
  const pg = imported.default || imported;
  const client = new pg.Client({
    connectionString: process.env.ALLY_PAYMENT_TEST_DATABASE_URL,
    connectionTimeoutMillis: 15000,
    query_timeout: 15000,
    application_name: "finserpay-ally-payment-eligibility-test",
    types: {
      getTypeParser(oid, format) {
        if (oid === 1114 && format !== "binary") {
          return (value) => new Date(value.replace(" ", "T") + "Z");
        }
        return pg.types.getTypeParser(oid, format);
      },
    },
  });

  const eligible = async (input, credits, paidCreditIds) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query(fixtureQuery(input, credits, paidCreditIds));
      return result.rows;
    } finally {
      await client.query("ROLLBACK");
    }
  };

  await client.connect();
  try {
    await t.test("el credito autorizado entra el 1 de septiembre y conserva el 31 de agosto", async () => {
      const rows = await eligible(periodInput("2026-09-01"), [fixtureCredit()]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, authorizedException.creditId);
      assert.equal(rows[0].fechaCredito.toISOString(), authorizedException.originalDate);
      assert.equal(rows[0].fechaLiquidacion.toISOString(), authorizedException.effectiveDate);
      assert.equal(rows[0].aliadoId, authorizedException.allyId);
    });

    await t.test("no extiende la excepcion a otro id con la misma cedula, otro aliado ni otra fecha", async () => {
      for (const credit of [
        fixtureCredit({ id: 190 }),
        fixtureCredit({ sedeId: 2 }),
        fixtureCredit({ fechaCredito: "2026-08-31T17:08:40.183Z" }),
        fixtureCredit({ fechaCredito: "2026-08-31T17:08:40.185Z" }),
      ]) {
        const rows = await eligible({ allyId: null }, [credit]);
        assert.equal(rows.length, 0, JSON.stringify(credit));
      }
    });

    await t.test("el aliado autenticado solo obtiene sus propios creditos", async () => {
      const credits = [
        fixtureCredit(),
        fixtureCredit({ id: 191, sedeId: 2, fechaCredito: "2026-09-01T12:00:00.000Z" }),
      ];
      const ownRows = await eligible(periodInput("2026-09-01"), credits);
      assert.deepEqual(ownRows.map((row) => row.id), [189]);
      const otherRows = await eligible(periodInput("2026-09-01", "2026-09-01", 65589), credits);
      assert.deepEqual(otherRows.map((row) => row.id), [191]);
    });

    await t.test("sigue excluyendo el credito pagado y cualquier estado anulado", async () => {
      assert.deepEqual(await eligible({ allyId: 65588 }, [fixtureCredit()], [189]), []);
      for (const estado of ["ANULADO", " anulada ", "CANCELADO", "cancelada"]) {
        assert.deepEqual(
          await eligible({ allyId: 65588 }, [fixtureCredit({ estado })]),
          [],
          estado
        );
      }
      assert.deepEqual(
        await eligible({ allyId: null }, [fixtureCredit({ sedeId: 3, fechaCredito: "2026-09-01T12:00:00.000Z" })]),
        []
      );
    });

    await t.test("aplica ambos limites del periodo a la fecha efectiva y a creditos ordinarios", async () => {
      const credits = [
        fixtureCredit(),
        fixtureCredit({ id: 190, fechaCredito: "2026-09-01T04:59:59.999Z" }),
        fixtureCredit({ id: 191, fechaCredito: "2026-09-01T05:00:00.000Z" }),
        fixtureCredit({ id: 192, fechaCredito: "2026-09-02T04:59:59.999Z", plataforma: "IPHONE" }),
        fixtureCredit({ id: 193, fechaCredito: "2026-09-02T05:00:00.000Z" }),
      ];
      const firstDay = await eligible(periodInput("2026-09-01"), credits);
      assert.deepEqual(firstDay.map((row) => row.id), [189, 191, 192]);
      const secondDay = await eligible(periodInput("2026-09-02"), credits);
      assert.deepEqual(secondDay.map((row) => row.id), [193]);
      for (const row of firstDay.filter((credit) => credit.id !== 189)) {
        assert.equal(row.fechaLiquidacion.toISOString(), row.fechaCredito.toISOString());
      }
    });

    await t.test("liquidar hasta el 5 deja automaticamente pendiente el credito del 6", async () => {
      const credits = [
        fixtureCredit(),
        fixtureCredit({ id: 195, fechaCredito: "2026-09-06T04:59:59.999Z" }),
        fixtureCredit({ id: 196, fechaCredito: "2026-09-06T05:00:00.000Z", plataforma: "IPHONE" }),
      ];
      const preview = await eligible(periodInput("2026-09-01", "2026-09-05"), credits);
      assert.deepEqual(preview.map((row) => row.id), [189, 195]);
      const paidCreditIds = preview.map((row) => row.id);
      const pending = await eligible({ allyId: 65588 }, credits, paidCreditIds);
      assert.deepEqual(pending.map((row) => row.id), [196]);
      assert.deepEqual(
        await eligible(periodInput("2026-09-01", "2026-09-05"), credits, paidCreditIds),
        []
      );
      const nextPeriod = await eligible(periodInput("2026-09-06"), credits, paidCreditIds);
      assert.deepEqual(nextPeriod.map((row) => row.id), [196]);
    });
  } finally {
    await client.end();
  }
});
