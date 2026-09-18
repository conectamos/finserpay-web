import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { ensureFinserPayCentralAdmin } = await jiti.import(
  "../lib/aliados.ts"
);

function centralAdminClient({ failFirst = false } = {}) {
  const calls = {
    aliadoUpsert: 0,
    sedeFind: 0,
    sedeUpdate: 0,
    usuarioUpdate: 0,
  };
  let pendingFailure = failFirst;

  return {
    calls,
    client: {
      aliado: {
        async upsert() {
          calls.aliadoUpsert += 1;
          if (pendingFailure) {
            pendingFailure = false;
            throw new Error("fallo transitorio");
          }
          return { id: 1 };
        },
      },
      sede: {
        async findFirst() {
          calls.sedeFind += 1;
          return { id: 2 };
        },
        async update() {
          calls.sedeUpdate += 1;
          return { id: 2 };
        },
        async create() {
          throw new Error("no debe crear una sede existente");
        },
      },
      usuario: {
        async updateMany() {
          calls.usuarioUpdate += 1;
          return { count: 1 };
        },
      },
    },
  };
}

test("ejecuta el bootstrap central una sola vez por cliente Prisma", async () => {
  const { calls, client } = centralAdminClient();

  const results = await Promise.all([
    ensureFinserPayCentralAdmin(client),
    ensureFinserPayCentralAdmin(client),
    ensureFinserPayCentralAdmin(client),
  ]);
  await ensureFinserPayCentralAdmin(client);

  assert.deepEqual(results, [{ id: 2 }, { id: 2 }, { id: 2 }]);
  assert.deepEqual(calls, {
    aliadoUpsert: 1,
    sedeFind: 1,
    sedeUpdate: 1,
    usuarioUpdate: 1,
  });
});

test("permite reintentar el bootstrap si el primer intento falla", async () => {
  const { calls, client } = centralAdminClient({ failFirst: true });

  await assert.rejects(
    ensureFinserPayCentralAdmin(client),
    /fallo transitorio/
  );
  assert.deepEqual(await ensureFinserPayCentralAdmin(client), { id: 2 });
  assert.equal(calls.aliadoUpsert, 2);
  assert.equal(calls.usuarioUpdate, 1);
});
