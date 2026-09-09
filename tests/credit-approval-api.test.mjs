import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovalModule, service, roles, approvalActors, approvalFixture, plain, pdf } from "./credit-approval-test-loader.mjs";

const centralAnalyst = { id: 7, nombre: "Analista de prueba", rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY", activo: true };
const context = (id = "81") => ({ params: Promise.resolve({ id }) });
const paths = {
  search: "app/api/aprobaciones/route.ts",
  detail: "app/api/aprobaciones/[id]/route.ts",
  evidence: "app/api/aprobaciones/[id]/evidencias/route.ts",
  document: "app/api/aprobaciones/[id]/documento/route.ts",
};

function apiHarness(user = centralAnalyst, methods = {}, transactionError = null) {
  const calls = [];
  const transactions = [];
  const database = {};
  const prisma = {
    async $transaction(callback, options) {
      transactions.push(options);
      if (transactionError) throw transactionError;
      return callback(database);
    },
  };
  const routedService = { ...service };
  for (const name of ["listCreditApprovals", "getCreditApprovalDetail", "approveCredit", "getApprovalEvidence", "getApprovalDocument"]) {
    routedService[name] = async (...args) => {
      calls.push({ name, args });
      assert.ok(name in methods, `Unexpected protected operation: ${name}`);
      return methods[name](...args);
    };
  }
  const http = loadApprovalModule("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/auth": { getCreditApprovalSessionUser: async () => user },
    "@/lib/roles": roles,
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => undefined },
    "@/lib/credit-approval-actor": approvalActors,
    "@/lib/credit-approval": service,
  });
  const routes = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, loadApprovalModule(path, {
    "next/server": { NextResponse: Response },
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-approval": routedService,
    "@/lib/credit-approval-actor": approvalActors,
    "@/lib/credit-approval-queue": { approvalQueueLimit: () => 50, listCreditApprovalQueue: async (...args) => { calls.push({ name: "listCreditApprovalQueue", args }); return methods.listCreditApprovalQueue(...args); } },
    "@/lib/credit-approval-evidence": {},
    "@/lib/credit-approval-http": http,
  })]));
  return { routes, calls, transactions, database, prisma, http };
}

const makeRequest = (path, method = "GET", body, headers = {}) => new Request(`https://finserpay.test${path}`, {
  method,
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  headers: { ...(body !== undefined ? { "content-type": "application/json", origin: "https://finserpay.test" } : {}), ...headers },
});

function privateResponse(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("todas las rutas niegan usuarios sin acceso antes de consultar o modificar datos", async (t) => {
  const scenarios = [
    ["sin sesión", null, 401],
    ["vendedor central", { ...centralAnalyst, rolNombre: "VENDEDOR" }, 403],
    ["administrador aliado", { ...centralAnalyst, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO_TEST" }, 403],
    ["analista de otro aliado", { ...centralAnalyst, aliadoAccesoCodigo: "ALIADO_TEST" }, 403],
    ["analista inactivo", { ...centralAnalyst, activo: false }, 403],
  ];
  for (const [name, user, status] of scenarios) await t.test(name, async () => {
    const api = apiHarness(user);
    const responses = [
      await api.routes.search.GET(makeRequest("/api/aprobaciones?documento=100000001")),
      await api.routes.detail.GET(makeRequest("/api/aprobaciones/81"), context()),
      await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", { revision: 1, reviewHash: "a".repeat(64) }), context()),
      await api.routes.evidence.GET(makeRequest("/api/aprobaciones/81/evidencias?tipo=cedula-frente"), context()),
      await api.routes.document.GET(makeRequest("/api/aprobaciones/81/documento"), context()),
    ];
    for (const response of responses) {
      assert.equal(response.status, status);
      privateResponse(response);
      assert.equal((await response.json()).ok, false);
    }
    assert.equal(api.calls.length, 0);
    assert.equal(api.transactions.length, 0);
  });
});

test("búsqueda exacta normaliza cédula y conserva varios folios", async () => {
  const returned = [{ id: 81, folio: "FNS-81" }, { id: 82, folio: "FNS-82" }];
  const api = apiHarness(centralAnalyst, { listCreditApprovals: async (_db, document) => {
    assert.equal(document, "100000001");
    return returned;
  } });
  const response = await api.routes.search.GET(makeRequest("/api/aprobaciones?documento=100.000.001"));
  assert.equal(response.status, 200);
  privateResponse(response);
  assert.deepEqual((await response.json()).items, returned);
  assert.equal(api.calls.length, 1);
});

test("abre la cola general autorizada y rechaza identificadores inválidos", async () => {
  const api = apiHarness(centralAnalyst, { listCreditApprovalQueue: async () => ({ items: [{ id: 81 }], nextCursor: null, hasMore: false }) });
  const response = await api.routes.search.GET(makeRequest("/api/aprobaciones"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, [{ id: 81 }]);
  privateResponse(response);
  for (const id of ["-1", "0", "81 OR 1=1"]) {
    const invalid = await api.routes.detail.GET(makeRequest("/api/aprobaciones/81"), context(id));
    assert.equal(invalid.status, 400);
  }
  assert.equal(api.calls.length, 1);
  assert.equal(api.transactions.length, 0);
});

test("detalle autorizado usa un snapshot transaccional y no entrega datos con caché", async () => {
  const fixture = approvalFixture();
  const detail = service.buildCreditApprovalDetail(fixture.credit, fixture.review, fixture.assessment, fixture.document);
  const api = apiHarness({ ...centralAnalyst, rolNombre: "ADMIN" }, { getCreditApprovalDetail: async (_db, id) => {
    assert.equal(id, 81);
    return detail;
  } });
  const response = await api.routes.detail.GET(makeRequest("/api/aprobaciones/81"), context());
  assert.equal(response.status, 200);
  privateResponse(response);
  assert.equal((await response.json()).item.id, 81);
  assert.equal(api.transactions[0].isolationLevel, "RepeatableRead");
});

test("POST transmite actor autenticado y revisión sin aceptar campos de crédito", async () => {
  const input = { revision: 2, reviewHash: "a".repeat(64) };
  const api = apiHarness(centralAnalyst, { approveCredit: async (_db, id, received, actor) => {
    assert.equal(id, 81);
    assert.deepEqual(plain(received), input);
    assert.deepEqual(plain(actor), { id: centralAnalyst.id, nombre: centralAnalyst.nombre });
    return { item: { id: 81, review: { status: "APPROVED" } }, unchanged: false };
  } });
  const response = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", input), context());
  assert.equal(response.status, 200);
  privateResponse(response);
  assert.equal((await response.json()).ok, true);
  assert.equal(api.transactions[0].isolationLevel, "ReadCommitted");

  const invalid = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", { ...input, montoCredito: 1 }), context());
  assert.equal(invalid.status, 400);
  assert.equal(api.calls.length, 1);
});

test("POST rechaza origen externo, JSON inválido y cuerpo excesivo sin abrir transacción", async () => {
  const api = apiHarness();
  const input = { revision: 1, reviewHash: "a".repeat(64) };
  const crossOrigin = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", input, { origin: "https://other.test" }), context());
  assert.equal(crossOrigin.status, 403);
  const crossSite = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", input, { "sec-fetch-site": "cross-site" }), context());
  assert.equal(crossSite.status, 403);
  const invalidJson = await api.routes.detail.POST(new Request("https://finserpay.test/api/aprobaciones/81", { method: "POST", body: "not-json" }), context());
  assert.equal(invalidJson.status, 400);
  const excessive = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", { ...input, extra: "a".repeat(1500) }), context());
  assert.equal(excessive.status, 400);
  assert.equal(api.calls.length, 0);
  assert.equal(api.transactions.length, 0);
});

test("conflicto de revisión obliga a recargar y conserva respuesta privada", async () => {
  const api = apiHarness(centralAnalyst, { approveCredit: async () => {
    throw new service.CreditApprovalError("REVIEW_CHANGED", "El expediente cambió.", 409);
  } });
  const response = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", { revision: 1, reviewHash: "a".repeat(64) }), context());
  assert.equal(response.status, 409);
  privateResponse(response);
  assert.equal((await response.json()).code, "REVIEW_CHANGED");
  assert.equal(api.calls.length, 1, "No hay reintento automático del servidor");
});

test("serialización y deadlock se presentan como conflicto revisable sin filtrar SQL", async () => {
  for (const code of ["P2034", "40001", "40P01"]) {
    const api = apiHarness(centralAnalyst, {}, { code, message: "SELECT private_data FROM internal_table" });
    const response = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", { revision: 1, reviewHash: "a".repeat(64) }), context());
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.code, "REVIEW_CHANGED");
    assert.doesNotMatch(payload.error, /SELECT|private_data/);
  }
});

test("fotos y PDF autorizado se sirven inline con MIME propio y sin caché", async () => {
  const imageBytes = Buffer.from([255, 216, 255, 0]);
  const pdfBytes = Buffer.from(pdf, "base64");
  const api = apiHarness(centralAnalyst, {
    getApprovalEvidence: async (_db, id, key) => {
      assert.equal(id, 81);
      assert.equal(key, "cedula-frente");
      return { bytes: imageBytes, mime: "image/jpeg" };
    },
    getApprovalDocument: async () => ({ bytes: pdfBytes, fileName: "credito-81.pdf" }),
  });
  const image = await api.routes.evidence.GET(makeRequest("/api/aprobaciones/81/evidencias?tipo=cedula-frente"), context());
  assert.equal(image.status, 200);
  privateResponse(image);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
  const document = await api.routes.document.GET(makeRequest("/api/aprobaciones/81/documento"), context());
  assert.equal(document.status, 200);
  privateResponse(document);
  assert.equal(document.headers.get("content-type"), "application/pdf");
  assert.match(document.headers.get("content-disposition"), /^inline; filename="credito-81\.pdf"$/);
  assert.deepEqual(Buffer.from(await document.arrayBuffer()), pdfBytes);
});

test("errores internos no revelan consultas ni datos sensibles", async () => {
  const api = apiHarness(centralAnalyst, { listCreditApprovals: async () => { throw new Error("database secret=example SELECT internal"); } });
  const response = await api.routes.search.GET(makeRequest("/api/aprobaciones?documento=100000001"));
  assert.equal(response.status, 503);
  privateResponse(response);
  assert.doesNotMatch(JSON.stringify(await response.json()), /secret=|SELECT|internal/);
});

test("POST compara Origin con Host público aunque Next reconstruya una URL interna", async () => {
  const accepted = [
    { url: "http://localhost:3117/api/aprobaciones/81", host: "127.0.0.1:3117", origin: "http://127.0.0.1:3117", forwardedProto: "http" },
    { url: "http://service.internal:8080/api/aprobaciones/81", host: "finserpay.test", origin: "https://finserpay.test", forwardedProto: "https" },
    { url: "http://localhost:3117/api/aprobaciones/81", host: "[::1]:3117", origin: "http://[::1]:3117", forwardedProto: "http" },
    { url: "http://service.internal:8080/api/aprobaciones/81", host: "FINSERPAY.TEST:443", origin: "https://finserpay.test", forwardedProto: "https" },
  ];
  for (const { url, host, origin, forwardedProto } of accepted) {
    const api = apiHarness(centralAnalyst, { approveCredit: async () => ({ unchanged: false }) });
    const request = new Request(url, {
      method: "POST",
      headers: { host, origin, "x-forwarded-host": host, "x-forwarded-proto": forwardedProto, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, reviewHash: "a".repeat(64) }),
    });
    const response = await api.routes.detail.POST(request, context());
    assert.equal(response.status, 200, `Origin válido para Host ${host}`);
    privateResponse(response);
    assert.equal(api.calls.length, 1);
  }
});

test("Host presente prevalece sobre URL interna y X-Forwarded-Host no amplía los orígenes", async () => {
  for (const origin of ["http://localhost:3117", "https://attacker.test", "https://finserpay.test.attacker.test", "https://sub.finserpay.test", "https://finserpay.test:8443"]) {
    const api = apiHarness();
    const request = new Request("http://localhost:3117/api/aprobaciones/81", {
      method: "POST",
      headers: { host: "finserpay.test", origin, "x-forwarded-host": new URL(origin).host, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ revision: 1, reviewHash: "a".repeat(64) }),
    });
    const response = await api.routes.detail.POST(request, context());
    assert.equal(response.status, 403, `No autorizar Origin ajeno ${origin}`);
    assert.equal((await response.json()).code, "INVALID_ORIGIN");
    assert.equal(api.calls.length, 0);
    assert.equal(api.transactions.length, 0);
  }
});

test("Origin malformado, opaco o con ruta recibe 403 y nunca se convierte en un error interno", async () => {
  for (const origin of ["", "null", "not-a-url", "javascript:alert(1)", "https://finserpay.test/", "https://finserpay.test/path", "https://finserpay.test?query=1", "https://finserpay.test#fragment", "https://user@finserpay.test", "https://finserpay.test, https://attacker.test"]) {
    const api = apiHarness();
    const request = makeRequest("/api/aprobaciones/81", "POST", { revision: 1, reviewHash: "a".repeat(64) }, { origin, host: "finserpay.test" });
    const response = await api.routes.detail.POST(request, context());
    assert.equal(response.status, 403, `Origin malformado: ${origin}`);
    privateResponse(response);
    assert.equal((await response.json()).code, "INVALID_ORIGIN");
    assert.equal(api.calls.length, 0);
    assert.equal(api.transactions.length, 0);
  }
});

test("Host vacío, múltiple o con componentes ajenos a una autoridad no habilita el OK", async () => {
  for (const host of ["", "finserpay.test,attacker.test", "finserpay.test/path", "user@finserpay.test", "finserpay.test?query=1", "finserpay.test:invalid"]) {
    const api = apiHarness();
    const response = await api.routes.detail.POST(makeRequest("/api/aprobaciones/81", "POST", { revision: 1, reviewHash: "a".repeat(64) }, { host }), context());
    assert.equal(response.status, 403, `Host inválido: ${host}`);
    assert.equal(api.calls.length, 0);
  }
});

test("Fetch Metadata no admite cross-site ni same-site aunque Origin y Host coincidan", async () => {
  for (const fetchSite of ["cross-site", "same-site", "Cross-Site", "same-origin, cross-site", "unexpected"]) {
    for (const withOrigin of [true, false]) {
      const api = apiHarness();
      const headers = { host: "finserpay.test", "sec-fetch-site": fetchSite };
      if (withOrigin) headers.origin = "https://finserpay.test";
      const response = await api.routes.detail.POST(new Request("https://finserpay.test/api/aprobaciones/81", {
        method: "POST", headers, body: JSON.stringify({ revision: 1, reviewHash: "a".repeat(64) }),
      }), context());
      assert.equal(response.status, 403, `Fetch Metadata rechazado: ${fetchSite}`);
      assert.equal(api.calls.length, 0);
      assert.equal(api.transactions.length, 0);
    }
  }
});

test("mantiene clientes autenticados sin Origin y usa URL solo cuando Host está ausente", async () => {
  for (const headers of [{}, { origin: "https://finserpay.test", "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }]) {
    const api = apiHarness(centralAnalyst, { approveCredit: async () => ({ unchanged: false }) });
    const response = await api.routes.detail.POST(new Request("https://finserpay.test/api/aprobaciones/81", {
      method: "POST", headers, body: JSON.stringify({ revision: 1, reviewHash: "a".repeat(64) }),
    }), context());
    assert.equal(response.status, 200);
    assert.equal(api.calls.length, 1);
  }
});

test("el lector permite un límite específico para fotos sin ampliar el cuerpo del OK", async () => {
  const { http } = apiHarness();
  const body = { data: "x".repeat(1600) };
  await assert.rejects(http.readApprovalRequest(makeRequest("/api/aprobaciones/81", "POST", body)), /demasiado extensa/);
  const parsed = await http.readApprovalRequest(makeRequest("/api/aprobaciones/81/evidencias", "PATCH", body), { maxBytes: 2000 });
  assert.deepEqual(plain(parsed), body);
  await assert.rejects(http.readApprovalRequest(makeRequest("/api/aprobaciones/81/evidencias", "PATCH", body), { maxBytes: 1000 }), /demasiado extensa/);
});

test("el lector corta un stream excesivo aunque no declare Content-Length", async () => {
  const { http } = apiHarness();
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(800)); }, cancel() { cancelled = true; } });
  const request = new Request("https://finserpay.test/api/aprobaciones/81", { method: "POST", body: stream, duplex: "half" });
  await assert.rejects(http.readApprovalRequest(request), /demasiado extensa/);
  assert.equal(cancelled, true);
});
