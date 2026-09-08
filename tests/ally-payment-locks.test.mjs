import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const storage = await readFile(
  new URL("../lib/ally-payments.ts", import.meta.url),
  "utf8"
);
const createSource = storage.slice(
  storage.indexOf("export async function createAllyPayment")
);
const callbackStart = createSource.indexOf("async (tx) => {");
const afterLocks = createSource.indexOf(
  "const ally = await requirePayableAlly(tx, allyId);",
  callbackStart
);
assert.ok(callbackStart >= 0 && afterLocks > callbackStart);
const transactionPrefix = createSource.slice(callbackStart, afterLocks);
const mutationId = "00000000-0000-4000-8000-000000000001";
const allyId = 42;

function compileLockPrefix(source = transactionPrefix) {
  return runInNewContext(`(${source} return "LOCKS_ACQUIRED"; })`, {
    mutationId,
    allyId,
    SETTLEMENT_INCLUDE: {},
  });
}

async function withVoidAdapter(run) {
  // A real adapter receives a synthetic PostgreSQL void result. The pool never
  // opens a connection and no query, transaction, or payment reaches a database.
  const pool = new pg.Pool();
  const calls = [];
  pool.query = async ({ text, values }) => {
    calls.push({ sql: text, values });
    return {
      fields: [{ name: "pg_advisory_xact_lock", dataTypeID: 2278 }],
      rows: [[""]],
      rowCount: 1,
    };
  };
  const adapter = await new PrismaPg(pool).connect();
  function rawQuery(sql, args) {
    return {
      sql,
      args,
      argTypes: args.map(() => ({ scalarType: "string", arity: "scalar" })),
    };
  }
  const rawClient = {
    $queryRawUnsafe: (sql, ...args) => adapter.queryRaw(rawQuery(sql, args)),
    $executeRawUnsafe: (sql, ...args) => adapter.executeRaw(rawQuery(sql, args)),
  };
  try {
    await run({ rawClient, calls });
  } finally {
    await adapter.dispose();
    await pool.end();
  }
}

function isUnsupportedVoid(error) {
  assert.equal(error.name, "DriverAdapterError");
  assert.equal(error.cause?.kind, "UnsupportedNativeDataType");
  assert.equal(error.cause?.type, "void");
  return true;
}

test("PrismaPg rechaza deserializar un lock void pero executeRaw lo ejecuta", async () => {
  await withVoidAdapter(async ({ rawClient, calls }) => {
    const sql = "SELECT pg_advisory_xact_lock(hashtext($1))";
    const key = "ALLY_PAYMENT_SYNTHETIC_LOCK";
    await assert.rejects(rawClient.$queryRawUnsafe(sql, key), isUnsupportedVoid);
    assert.equal(await rawClient.$executeRawUnsafe(sql, key), 1);
    assert.deepEqual(calls, [
      { sql, values: [key] },
      { sql, values: [key] },
    ]);
  });
});

test("los dos locks reales de pagos atraviesan PrismaPg sin leer columnas void", async () => {
  await withVoidAdapter(async ({ rawClient, calls }) => {
    const events = [];
    const tx = {
      ...rawClient,
      $queryRawUnsafe() {
        assert.fail("Los locks void no pueden usar queryRawUnsafe");
      },
      async $executeRawUnsafe(sql, key) {
        events.push(key);
        return rawClient.$executeRawUnsafe(sql, key);
      },
      liquidacionAliado: {
        async findUnique({ where }) {
          assert.equal(where.mutationId, mutationId);
          events.push("CHECK_EXISTING");
          return null;
        },
      },
    };
    assert.equal(await compileLockPrefix()(tx), "LOCKS_ACQUIRED");
    assert.deepEqual(events, [
      "ALLY_PAYMENT_MUTATION:" + mutationId,
      "CHECK_EXISTING",
      "ALLY_PAYMENT_ALLY:" + allyId,
    ]);
    assert.equal(calls.length, 2);
  });
});

test("el patron anterior falla antes de consultar o registrar una liquidacion", async () => {
  await withVoidAdapter(async ({ rawClient, calls }) => {
    let settlementCalls = 0;
    const tx = {
      ...rawClient,
      liquidacionAliado: {
        async findUnique() {
          settlementCalls += 1;
          return null;
        },
        async create() {
          settlementCalls += 1;
          assert.fail("No debe registrarse un pago con el lock fallido");
        },
      },
    };
    const oldPrefix = transactionPrefix.replaceAll(
      "$executeRawUnsafe",
      "$queryRawUnsafe"
    );
    await assert.rejects(compileLockPrefix(oldPrefix)(tx), isUnsupportedVoid);
    assert.equal(settlementCalls, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, ["ALLY_PAYMENT_MUTATION:" + mutationId]);
  });
});
