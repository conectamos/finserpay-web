import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const centralAdmin = {
  id: 1,
  rolNombre: "ADMIN",
  aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 1,
  sedeId: 1,
};

const allyAdmin = {
  id: 7,
  rolNombre: "ADMIN",
  aliadoAccesoCodigo: "JG-COMPANY",
  aliadoAccesoId: 7,
  sedeId: 17,
};

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadRoute(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = { exports: {} };

  runInNewContext(
    outputText,
    {
      console,
      Date,
      exports: loaded.exports,
      module: loaded,
      require(name) {
        assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
        return dependencies[name];
      },
      Response,
      URL,
      URLSearchParams,
    },
    { filename: path }
  );

  return loaded.exports;
}

function isFinserPayCentralAlly(code) {
  return String(code || "").trim().toUpperCase() === "FINSERPAY";
}

function resolveCarteraAliadoId({ adminCentral, ownAliadoId, requestedAliadoId }) {
  const candidate = adminCentral ? requestedAliadoId : ownAliadoId;
  const parsed = Number(String(candidate ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function credit(id, aliadoId, documento) {
  return {
    abonos: [],
    aliadoId,
    clienteDocumento: documento,
    clienteNombre: `Cliente ${id}`,
    estado: "INSCRITO",
    fechaPrimerPago: null,
    fechaProximoPago: null,
    folio: `FC-${id}`,
    frecuenciaPago: "QUINCENAL",
    id,
    montoCredito: 1_000_000,
    plazoMeses: 12,
    valorCuota: 100_000,
  };
}

function pushHarness({ user = allyAdmin, rows = [] } = {}) {
  const activity = {
    audits: 0,
    queries: [],
    tokenDocuments: [],
  };
  const database = {
    credito: {
      async findMany(query) {
        activity.queries.push(plain(query));
        const requestedId = Number(query.where?.id || 0);
        const scopedAliadoId = Number(query.where?.sede?.aliadoId || 0);

        return rows.filter((row) => {
          if (requestedId > 0 && row.id !== requestedId) return false;
          if (scopedAliadoId > 0 && row.aliadoId !== scopedAliadoId) return false;
          return true;
        });
      },
    },
  };
  const route = loadRoute("app/api/creditos/push-manual/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/aliados": { isFinserPayCentralAlly },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/cartera-access": { resolveCarteraAliadoId },
    "@/lib/credit-abono-audit": {
      ensureCreditAbonoAuditColumns: async () => {
        activity.audits += 1;
      },
    },
    "@/lib/credit-payment-plan": {
      buildCreditPaymentPlan: () => ({
        estadoPago: "AL_DIA",
        nextInstallment: null,
      }),
    },
    "@/lib/fcm-notifications": {
      isFcmConfigured: () => true,
      listFcmTokensForDocument: async (documento) => {
        activity.tokenDocuments.push(documento);
        return [];
      },
      markFcmTokenSendResult: async () => {},
      sendFcmNotification: async () => ({ ok: true, error: null }),
    },
    "@/lib/prisma": { __esModule: true, default: database },
    "@/lib/roles": {
      isAdminRole: (role) => String(role || "").trim().toUpperCase() === "ADMIN",
    },
  });

  return {
    activity,
    async post(body) {
      return route.POST(
        new Request("https://finserpay.test/api/creditos/push-manual", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    },
  };
}

test("push manual limita por aliado los modos credit y bulk", async (t) => {
  const own = credit(71, 7, "1000000071");
  const foreign = credit(91, 9, "1000000091");

  await t.test("credit no procesa un crédito ajeno aunque conozcan su id", async () => {
    const harness = pushHarness({ rows: [own, foreign] });
    const response = await harness.post({
      creditoId: foreign.id,
      dryRun: true,
      mode: "credit",
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(harness.activity.queries.length, 1);
    assert.equal(harness.activity.queries[0].where.id, foreign.id);
    assert.deepEqual(harness.activity.queries[0].where.sede, { aliadoId: 7 });
    assert.deepEqual(harness.activity.tokenDocuments, []);
    assert.equal(payload.summary.targetCredits, 0);
  });

  await t.test("bulk consulta y procesa únicamente créditos del aliado", async () => {
    const harness = pushHarness({ rows: [own, foreign] });
    const response = await harness.post({
      dryRun: true,
      filter: "TODOS_APP",
      mode: "bulk",
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(harness.activity.queries[0].where.sede, { aliadoId: 7 });
    assert.deepEqual(harness.activity.tokenDocuments, [own.clienteDocumento]);
    assert.equal(payload.summary.targetCredits, 1);
    assert.equal(payload.items[0].creditoId, own.id);
  });
});

test("push manual falla cerrado cuando el admin aliado no tiene aliado asignado", async () => {
  const harness = pushHarness({
    user: { ...allyAdmin, aliadoAccesoId: null },
    rows: [credit(71, 7, "1000000071")],
  });
  const response = await harness.post({
    creditoId: 71,
    dryRun: true,
    mode: "credit",
  });

  assert.equal(response.status, 403);
  assert.deepEqual(harness.activity.queries, []);
  assert.deepEqual(harness.activity.tokenDocuments, []);
  assert.equal(harness.activity.audits, 0);
});

test("push manual conserva alcance global para el administrador central", async () => {
  const rows = [credit(71, 7, "1000000071"), credit(91, 9, "1000000091")];
  const harness = pushHarness({ user: centralAdmin, rows });

  const creditResponse = await harness.post({
    creditoId: 91,
    dryRun: true,
    mode: "credit",
  });
  const bulkResponse = await harness.post({
    dryRun: true,
    filter: "TODOS_APP",
    mode: "bulk",
  });

  assert.equal(creditResponse.status, 200);
  assert.equal(bulkResponse.status, 200);
  assert.equal("sede" in harness.activity.queries[0].where, false);
  assert.equal("sede" in harness.activity.queries[1].where, false);
  assert.deepEqual(harness.activity.tokenDocuments, [
    "1000000091",
    "1000000071",
    "1000000091",
  ]);
});

function financialHarness(user = allyAdmin) {
  const activity = {
    databaseCalls: 0,
    getQueries: [],
  };
  const touch = () => {
    activity.databaseCalls += 1;
  };
  const database = {
    gastoCartera: {
      async findMany(query) {
        touch();
        activity.getQueries.push(plain(query));
        return [];
      },
      async findUnique() {
        touch();
        return null;
      },
    },
    sede: {
      async findUnique() {
        touch();
        return { id: 1 };
      },
    },
    async $transaction() {
      touch();
      throw new Error("La transacción no debe ejecutarse en esta prueba");
    },
  };
  const financialAccess = async () => ({
    esAdmin: true,
    ok: true,
    user,
  });
  const route = loadRoute("app/api/financiero/cartera/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/aliados": { isFinserPayCentralAlly },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/financial-access": { requireFinancialAccess: financialAccess },
    "@/lib/prisma": { __esModule: true, default: database },
  });

  return { activity, route };
}

function jsonRequest(method, body) {
  return new Request("https://finserpay.test/api/financiero/cartera", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("gastos de cartera rechaza al ADMIN aliado en GET, POST, PATCH y DELETE", async () => {
  const { activity, route } = financialHarness();
  const responses = await Promise.all([
    route.GET(new Request("https://finserpay.test/api/financiero/cartera?sedeId=99")),
    route.POST(jsonRequest("POST", { observacion: "Intento", sedeId: 99, valor: 1000 })),
    route.PATCH(jsonRequest("PATCH", { id: 1, observacion: "Intento", sedeId: 99, valor: 1000 })),
    route.DELETE(jsonRequest("DELETE", { id: 1 })),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403]
  );
  assert.equal(activity.databaseCalls, 0);
  for (const response of responses) {
    assert.match((await response.json()).error, /administrador central/i);
  }
});

test("el administrador central conserva la consulta global de gastos", async () => {
  const { activity, route } = financialHarness(centralAdmin);
  const response = await route.GET(
    new Request("https://finserpay.test/api/financiero/cartera")
  );

  assert.equal(response.status, 200);
  assert.equal(activity.databaseCalls, 1);
  assert.deepEqual(activity.getQueries[0].where, {});
});
