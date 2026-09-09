import assert from "node:assert/strict";
import test from "node:test";
import { core, loadBlacklistModule } from "./document-blacklist-test-loader.mjs";

const bulkCore = loadBlacklistModule("lib/document-blacklist-bulk-core.ts", {
  "@/lib/document-blacklist-core": core,
});
const bulkStore = loadBlacklistModule("lib/document-blacklist-bulk-store.ts", {
  "@/lib/document-blacklist-core": core,
  "@/lib/document-blacklist-bulk-core": bulkCore,
});
const bulkRequest = loadBlacklistModule("lib/document-blacklist-bulk-request.ts", {
  "@/lib/document-blacklist-core": core,
});
const nextServer = { NextResponse: { json: (value, init) => Response.json(value, init) } };
const blacklistResponse = loadBlacklistModule("lib/document-blacklist-response.ts", {
  "next/server": nextServer,
  "@/lib/document-blacklist-core": core,
});
const actor = { id: 19, nombre: "Administrador central de prueba" };
const validBody = {
  texto: "1062402825\n1062402826",
  motivo: "Validación interna solicitada por central",
  fingerprint: "a".repeat(64),
  mutationId: "8459fd67-b8aa-4d8b-ae88-969bcf12329d",
  confirmed: true,
};

function makeHarness(kind, options = {}) {
  const calls = { access: 0, preview: [], commit: [], queries: [], executions: [], transactions: [] };
  const tx = { marker: "transaction" };
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      calls.queries.push({ sql, params });
      if (options.queryError) throw options.queryError;
      return options.existing ?? [];
    },
    async $executeRawUnsafe(sql, ...params) {
      calls.executions.push({ sql, params });
      throw new Error("La previsualización no debe escribir en la base de datos.");
    },
    async $transaction(callback, settings) {
      calls.transactions.push(settings);
      if (options.transactionError) throw options.transactionError;
      return callback(tx);
    },
  };
  const dependencies = {
    "next/server": nextServer,
    "@/lib/datacredito/admin-access": {
      async getDataCreditoCentralAdmin() {
        calls.access += 1;
        return options.access ?? { ok: true, status: 200, user: actor };
      },
    },
    "@/lib/document-blacklist-core": core,
    "@/lib/document-blacklist-bulk-core": bulkCore,
    "@/lib/document-blacklist-bulk-request": bulkRequest,
    "@/lib/document-blacklist-response": blacklistResponse,
    "@/lib/document-blacklist-bulk-store": {
      ...bulkStore,
      async previewBlacklistBulk(database, input, currentActor) {
        calls.preview.push({ database, input, actor: currentActor });
        return bulkStore.previewBlacklistBulk(database, input, currentActor);
      },
      async commitBlacklistBulk(database, input, currentActor) {
        calls.commit.push({ database, input, actor: currentActor });
        if (options.commitError) throw options.commitError;
        return {
          importId: input.mutationId,
          summary: { total: 2, nuevas: 2, reactivar: 0, yaBloqueadas: 0, duplicadas: 0, invalidas: 0 },
          items: input.parsed.documentos.map((documento) => ({ documento, accion: "BLOQUEADA" })),
          createdAt: "2026-09-09T00:00:00.000Z",
          actorName: currentActor.nombre,
          idempotent: false,
        };
      },
    },
    "@/lib/prisma": { default: db },
  };
  const path = kind === "preview"
    ? "app/api/lista-negra/masivo/previsualizar/route.ts"
    : "app/api/lista-negra/masivo/route.ts";
  return { route: loadBlacklistModule(path, dependencies), calls, db, tx };
}

function requestFor(body = validBody, extraHeaders = {}) {
  return new Request("https://finserpay.example/api/lista-negra/masivo", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  assert.deepEqual(Object.keys(body).sort(), ["code", "error", "ok"]);
  return body;
}

function assertNoStorage(calls) {
  assert.equal(calls.preview.length, 0);
  assert.equal(calls.commit.length, 0);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.executions.length, 0);
  assert.equal(calls.transactions.length, 0);
}

for (const kind of ["preview", "commit"]) {
  for (const status of [401, 403]) {
    test(`${kind}: exige acceso central (${status}) antes de tocar el cuerpo o consultar datos`, async () => {
      const { route, calls } = makeHarness(kind, {
        access: { ok: false, status, user: { id: 80, nombre: "Aliado", motivo: "Motivo privado que no debe filtrarse" } },
      });
      let requestReads = 0;
      const forbiddenRequest = new Proxy({}, {
        get() {
          requestReads += 1;
          throw new Error("No se debe leer ni el encabezado ni el cuerpo antes de autorizar.");
        },
      });
      const body = await assertError(await route.POST(forbiddenRequest), status, "FORBIDDEN");
      assert.equal(body.error, "Acceso no autorizado.");
      assert.equal(requestReads, 0);
      assert.equal(calls.access, 1);
      assertNoStorage(calls);
    });
  }

  test(`${kind}: no expone GET ni otros métodos de escritura`, () => {
    const { route } = makeHarness(kind);
    assert.equal(typeof route.POST, "function");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(route[method], undefined);
    assert.equal(route.runtime, "nodejs");
    assert.equal(route.dynamic, "force-dynamic");
  });

  test(`${kind}: devuelve 400 por JSON inválido sin acceso al almacenamiento`, async () => {
    const { route, calls } = makeHarness(kind);
    const request = new Request("https://finserpay.example/api/lista-negra/masivo", { method: "POST", body: "{json roto" });
    await assertError(await route.POST(request), 400, "INVALID_REQUEST");
    assertNoStorage(calls);
  });

  test(`${kind}: rechaza 413 por Content-Length antes de consumir el cuerpo`, async () => {
    const { route, calls } = makeHarness(kind);
    let bodyReads = 0;
    const request = {
      headers: new Headers({ "content-length": "150001" }),
      get body() { bodyReads += 1; throw new Error("No consumir un cuerpo ya demasiado grande."); },
    };
    await assertError(await route.POST(request), 413, "BULK_BODY_TOO_LARGE");
    assert.equal(bodyReads, 0);
    assertNoStorage(calls);
  });

  for (const declaredLength of [undefined, "20"]) {
    test(`${kind}: limita bytes reales aunque Content-Length sea ${declaredLength ?? "ausente"}`, async () => {
      const { route, calls } = makeHarness(kind);
      const body = JSON.stringify({ ...validBody, extra: "é".repeat(75_000) });
      assert.ok(body.length < 150_000, "El límite debe ser por bytes, no por caracteres.");
      const request = new Request("https://finserpay.example/api/lista-negra/masivo", {
        method: "POST",
        headers: declaredLength ? { "content-length": declaredLength } : {},
        body,
      });
      await assertError(await route.POST(request), 413, "BULK_BODY_TOO_LARGE");
      assertNoStorage(calls);
    });
  }

  test(`${kind}: exige un motivo válido antes de usar la base de datos`, async () => {
    const { route, calls } = makeHarness(kind);
    const response = await route.POST(requestFor({ ...validBody, motivo: "" }));
    assert.equal(response.status, 400);
    assertNoStorage(calls);
  });
}

test("previsualizar usa el actor autenticado, normaliza, clasifica y no escribe", async () => {
  const { route, calls, db } = makeHarness("preview", {
    existing: [{ id: "existing", documento: "1062402826", activa: true, version: 2, motivo: "Motivo histórico privado" }],
  });
  const response = await route.POST(requestFor({
    texto: "1.062.402.825\n1062402826\n1062402825\ntexto inválido",
    motivo: validBody.motivo,
    actor: { id: 99, nombre: "Actor falsificado" }, actorUserId: 99, actorName: "Actor falsificado",
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.summary, { total: 4, nuevas: 1, reactivar: 0, yaBloqueadas: 1, duplicadas: 1, invalidas: 1 });
  assert.deepEqual(body.rows.map((row) => row.status), ["NUEVA", "YA_BLOQUEADA", "DUPLICADA", "INVALIDA"]);
  assert.equal(body.canConfirm, false);
  assert.match(body.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(body.maxEntries, 500);
  assert.equal(JSON.stringify(body).includes("Motivo histórico privado"), false);
  assert.equal(calls.preview.length, 1);
  assert.equal(calls.preview[0].actor, actor);
  assert.equal(calls.preview[0].database, db);
  assert.equal(calls.queries.length, 1);
  assert.match(calls.queries[0].sql, /^SELECT /);
  assert.equal(calls.executions.length, 0);
  assert.equal(calls.transactions.length, 0);
  assert.equal(calls.commit.length, 0);
});

test("confirmar usa una transacción y la identidad de sesión, nunca campos de actor enviados", async () => {
  const { route, calls, tx } = makeHarness("commit");
  const response = await route.POST(requestFor({
    ...validBody, fingerprint: "A".repeat(64),
    actor: { id: 99, nombre: "Actor falsificado" }, actorUserId: 99, actorName: "Actor falsificado",
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.actorName, actor.nombre);
  assert.equal(body.importId, validBody.mutationId);
  assert.equal(calls.commit.length, 1);
  assert.equal(calls.commit[0].database, tx);
  assert.equal(calls.commit[0].actor, actor);
  assert.equal(calls.commit[0].input.fingerprint, "a".repeat(64));
  assert.equal(calls.commit[0].input.confirmed, true);
  assert.equal("actorUserId" in calls.commit[0].input, false);
  assert.equal("actor" in calls.commit[0].input, false);
  assert.equal(calls.transactions.length, 1);
  assert.ok(calls.transactions[0].timeout > 0);
  assert.equal(calls.preview.length, 0);
});

for (const confirmed of [undefined, false, "true", 1]) {
  test(`confirmar exige confirmed === true; rechaza ${String(confirmed)}`, async () => {
    const { route, calls } = makeHarness("commit");
    await assertError(await route.POST(requestFor({ ...validBody, confirmed })), 400, "BULK_CONFIRMATION_REQUIRED");
    assertNoStorage(calls);
  });
}

for (const fingerprint of [undefined, "", "a".repeat(63), "g".repeat(64), 123]) {
  test(`confirmar rechaza una huella de previsualización inválida: ${String(fingerprint)}`, async () => {
    const { route, calls } = makeHarness("commit");
    await assertError(await route.POST(requestFor({ ...validBody, fingerprint })), 400, "INVALID_BULK_PREVIEW");
    assertNoStorage(calls);
  });
}

for (const mutationId of [undefined, "", "request-not-uuid", 123]) {
  test(`confirmar rechaza mutationId inválido: ${String(mutationId)}`, async () => {
    const { route, calls } = makeHarness("commit");
    await assertError(await route.POST(requestFor({ ...validBody, mutationId })), 400, "INVALID_REQUEST_ID");
    assertNoStorage(calls);
  });
}

test("previsualizar falla cerrado ante almacenamiento no disponible y no expone detalles", async () => {
  const { route, calls } = makeHarness("preview", { queryError: new Error("SQL con motivo interno secreto y conexión privada") });
  const body = await assertError(await route.POST(requestFor()), 503, "DOCUMENT_BLACKLIST_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("secreto"), false);
  assert.equal(calls.queries.length, 1);
  assert.equal(calls.executions.length, 0);
  assert.equal(calls.commit.length, 0);
});

test("confirmar falla cerrado si no se puede iniciar la transacción y no expone detalles", async () => {
  const { route, calls } = makeHarness("commit", { transactionError: new Error("Host de base de datos privado y motivo secreto") });
  const body = await assertError(await route.POST(requestFor()), 503, "DOCUMENT_BLACKLIST_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("secreto"), false);
  assert.equal(calls.transactions.length, 1);
  assert.equal(calls.commit.length, 0);
});

for (const code of ["BULK_PREVIEW_CHANGED", "MUTATION_CONFLICT"]) {
  test(`confirmar conserva el 409 recuperable por ${code}`, async () => {
    const { route, calls } = makeHarness("commit", { commitError: new core.DocumentBlacklistError(code, "Vuelve a previsualizar.", 409) });
    await assertError(await route.POST(requestFor()), 409, code);
    assert.equal(calls.transactions.length, 1);
    assert.equal(calls.commit.length, 1);
  });
}

test("el lector cancela el flujo al superar el límite y libera el bloqueo", async () => {
  let canceled = false;
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array(100_000));
    },
    cancel() { canceled = true; },
  });
  await assert.rejects(bulkRequest.readBlacklistBulkJson({ headers: new Headers(), body: stream }),
    (error) => error.status === 413 && error.code === "BULK_BODY_TOO_LARGE");
  assert.equal(canceled, true);
  assert.ok(reads <= 3, "No continúa consumiendo un flujo sin límite.");
  assert.equal(stream.locked, false);
});

test("el lector acepta UTF-8 partido en chunks y rechaza secuencias UTF-8 inválidas", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ texto: "1062402825", motivo: "Cédula reportada" }));
  const accentedIndex = encoded.indexOf(0xc3);
  const validStream = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, accentedIndex + 1));
    controller.enqueue(encoded.slice(accentedIndex + 1));
    controller.close();
  } });
  const parsed = await bulkRequest.readBlacklistBulkJson({ headers: new Headers(), body: validStream });
  assert.equal(parsed.motivo, "Cédula reportada");
  assert.equal(validStream.locked, false);
  const invalidStream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff, 0xfe])); controller.close(); } });
  await assert.rejects(bulkRequest.readBlacklistBulkJson({ headers: new Headers(), body: invalidStream }),
    (error) => error.status === 400 && error.code === "INVALID_REQUEST");
  assert.equal(invalidStream.locked, false);
});
