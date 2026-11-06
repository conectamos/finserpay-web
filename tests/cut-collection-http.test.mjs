import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CutCollectionError, parseCutFilters, cutAccessFromDashboard } = await jiti.import("../lib/cut-collection-access.ts");
const root = path.resolve(import.meta.dirname, "..");
const url = "https://finser.example/api/reportes/recaudo-por-corte";
const filters = { day: 17, month: 10, year: 2026, aliadoId: 1, sedeId: 10, status: "parcial" };
const query = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]));
const access = { userId: 8, central: false, aliadoId: 1, sedeId: 10 };
const report = { ok: true, mode: "consulta", cutDate: "2026-10-17", projection: null, history: [],
  historyPage: 0, historyHasMore: false, rows: [], filters, summary: { creditsCount: 0 } };
const pdfBytes = Buffer.from("%PDF-local-http-fixture");
const registeredRecipient = "aliado-registrado@example.test";
const requestKey = "1d34cc6f-8bf8-4277-b1a4-2f908a6ca9ab";
class CutCollectionEmailError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function compile(file, resolve) {
  const source = readFileSync(path.join(root, file), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const mod = { exports: {} };
  new Function("require", "module", "exports", outputText)(resolve, mod, mod.exports);
  return mod.exports;
}

// Exercise the actual origin guard without loading provider or database modules.
const { assertAttentionOrigin } = compile("lib/atencion-http.ts", name => {
  const mocks = {
    "./atencion-core": { AttentionError: CutCollectionError },
    "./atencion-dapta": { AttentionDaptaError: Error },
    "./atencion-meta": { AttentionMetaError: Error },
  };
  assert.ok(name in mocks, `Dependencia inesperada del validador HTTP: ${name}`);
  return mocks[name];
});

// Real handlers, origin guard and filter parsing. Dynamic document/delivery
// imports are isolated too: tests never reach a live database or mail provider.
function harness(overrides = {}) {
  const calls = { access: 0, parse: [], read: [], legacyRead: [], save: [], excel: [], origin: [], pdf: [], recipient: [], email: [], order: [] };
  function scopedRequire(name) {
    if (name === "@/lib/cut-collection-access") return {
      CutCollectionError,
      getCutCollectionAccess: async () => { calls.access++; calls.order.push("access"); if (overrides.accessError) throw overrides.accessError; return overrides.access ?? access; },
      parseCutFilters: value => {
        calls.order.push("parse");
        calls.parse.push(Object.fromEntries(value));
        return parseCutFilters(value, new Date("2026-11-02T15:00:00Z"));
      },
    };
    if (name === "@/lib/cut-collection-storage") return {
      getDirectCutCollectionReport: async (...args) => { calls.read.push(args); calls.order.push("report"); if (overrides.error) throw overrides.error; return report; },
      getCutCollectionReport: async (...args) => { calls.legacyRead.push(args); throw new Error("No se debe consultar una proyección"); },
      saveCutCollectionProjection: async (...args) => { calls.save.push(args); throw new Error("No se debe guardar una proyección"); },
    };
    if (name === "@/lib/cut-collection-excel") return {
      buildCutCollectionWorkbook: value => { calls.excel.push(value); return { xlsx: { writeBuffer: async () => Buffer.from("PK-test") } }; },
    };
    if (name === "@/lib/atencion-http") return {
      assertAttentionOrigin: request => { calls.origin.push(request); calls.order.push("origin"); return assertAttentionOrigin(request); },
    };
    if (name === "@/lib/cut-collection-pdf") return {
      buildCutCollectionPdf: async value => { calls.pdf.push(value); calls.order.push("pdf"); if (overrides.pdfError) throw overrides.pdfError; return pdfBytes; },
    };
    if (name === "@/lib/cut-collection-email") return {
      CutCollectionEmailError,
      getCutCollectionRecipient: async id => { calls.recipient.push(id); calls.order.push("recipient"); if (overrides.recipientError) throw overrides.recipientError; return registeredRecipient; },
      sendCutCollectionEmail: async input => { calls.email.push(input); calls.order.push("email"); if (overrides.emailError) throw overrides.emailError; },
    };
    assert.fail(`Dependencia no aislada: ${name}`);
  }
  return { ...compile("app/api/reportes/recaudo-por-corte/route.ts", scopedRequire), calls };
}

function emailRequest({ headers = {}, params = query.toString(), body = {} } = {}) {
  const merged = new Headers({ origin: new URL(url).origin, "content-type": "application/json", "idempotency-key": requestKey });
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) merged.delete(key);
    else merged.set(key, value);
  }
  return new Request(`${url}?${params}&action=email`, { method: "POST", headers: merged, body: JSON.stringify(body) });
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("GET y POST exigen sesión y permisos antes de consultar o rechazar la operación retirada", async () => {
  for (const status of [401, 403]) {
    const handler = harness({ accessError: new CutCollectionError("Sin acceso", status) });
    for (const response of [await handler.GET(new Request(url)), await handler.POST(new Request(url, { method: "POST" })),
      await handler.GET(new Request(`${url}?${query}&format=pdf`)), await handler.POST(emailRequest())]) {
      assert.equal(response.status, status);
      assertPrivate(response);
    }
    assert.equal(handler.calls.read.length, 0);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
    for (const stage of ["origin", "parse", "recipient", "pdf", "email"]) assert.equal(handler.calls[stage].length, 0);
  }
});

test("consulta directa recibe los filtros y el alcance real de central, aliado y supervisor", async () => {
  for (const dashboard of [
    { admin: true, supervisor: false, session: { id: 8, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "FINSERPAY" } },
    { admin: true, supervisor: false, session: { id: 8, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "ALIADO" } },
    { admin: false, supervisor: true, session: { id: 8, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "ALIADO" } },
  ]) {
    const authorized = cutAccessFromDashboard(dashboard);
    const handler = harness({ access: authorized });
    const response = await handler.GET(new Request(`${url}?${query}&central=true&userId=999`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), report);
    assert.deepEqual(handler.calls.read, [[authorized, filters]]);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
    assertPrivate(response);
  }
});

test("enlaces heredados ignoran ID y página de proyección incluso vacíos, inválidos o repetidos", async () => {
  for (const inherited of [
    "projectionId=&historyPage=", "projectionId=../../secret&historyPage=-1",
    "projectionId=old&projectionId=other&historyPage=bad&historyPage=100001",
    "projectionId=d088e4a2-c9d0-4310-aa0d-6023b48b2196&historyPage=4",
  ]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?${query}&${inherited}`));
    assert.equal(response.status, 200);
    assert.deepEqual(handler.calls.read, [[access, filters]]);
    assert.equal("projectionId" in handler.calls.parse[0], false);
    assert.equal("historyPage" in handler.calls.parse[0], false);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
  }
});

test("Excel usa exactamente el reporte directo filtrado y nombra el archivo por fecha", async () => {
  const handler = harness();
  const response = await handler.GET(new Request(`${url}?${query}&format=xlsx&projectionId=invalid&historyPage=old`));
  assert.equal(response.status, 200);
  assert.deepEqual(handler.calls.read, [[access, filters]]);
  assert.deepEqual(handler.calls.excel, [report]);
  assert.equal(handler.calls.legacyRead.length, 0);
  assert.equal(handler.calls.save.length, 0);
  assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="FINSERPAY_Recaudo_2026-10-17.xlsx"');
  assert.equal(response.headers.get("content-length"), "7");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "PK-test");
  assertPrivate(response);
});

test("PDF exporta el reporte completo autorizado con los mismos filtros y encabezados privados", async () => {
  const handler = harness();
  const response = await handler.GET(new Request(`${url}?${query}&format=pdf&projectionId=legacy&historyPage=invalid`));
  assert.equal(response.status, 200);
  assert.deepEqual(handler.calls.read, [[access, filters]]);
  assert.deepEqual(handler.calls.pdf, [report]);
  for (const stage of ["excel", "recipient", "email", "legacyRead", "save"]) assert.equal(handler.calls[stage].length, 0);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="FINSERPAY_Recaudo_2026-10-17.pdf"');
  assert.equal(response.headers.get("content-length"), String(pdfBytes.byteLength));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);
  assertPrivate(response);
});

test("POST responde 410 tras autorizar sin leer el cuerpo, consultar ni guardar", async () => {
  for (const body of ["{", JSON.stringify({ ...filters, requestKey: "old", snapshot: { expected: 1 }, userId: 999 })]) {
    const handler = harness();
    const request = new Request(url, { method: "POST", body });
    const response = await handler.POST(request);
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /consulta directamente/);
    assert.equal(request.bodyUsed, false);
    assert.equal(handler.calls.access, 1);
    assert.equal(handler.calls.parse.length, 0);
    assert.equal(handler.calls.read.length, 0);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
    assertPrivate(response);
  }
});

test("enviar correo exige origen propio, JSON, UUID v4, filtros válidos y un aliado explícito", async () => {
  const withoutAlly = new URLSearchParams(query);
  withoutAlly.delete("aliadoId");
  for (const [options, status] of [
    [{ headers: { origin: null } }, 403],
    [{ headers: { origin: "https://attacker.example" } }, 403],
    [{ headers: { origin: "null" } }, 403],
    [{ headers: { "sec-fetch-site": "cross-site" } }, 403],
    [{ headers: { "content-type": null } }, 415],
    [{ headers: { "content-type": "text/plain" } }, 415],
    [{ headers: { "idempotency-key": null } }, 400],
    [{ headers: { "idempotency-key": "not-a-uuid" } }, 400],
    [{ headers: { "idempotency-key": "1d34cc6f-8bf8-1277-b1a4-2f908a6ca9ab" } }, 400],
    [{ params: withoutAlly.toString() }, 400],
    [{ params: `${query}&aliadoId=2` }, 400],
    [{ params: "day=3&aliadoId=1" }, 400],
    [{ params: "day=17&aliadoId=1&sedeId=-10" }, 400],
    [{ params: "day=17&aliadoId=1&status=invalid" }, 400],
  ]) {
    const handler = harness();
    const response = await handler.POST(emailRequest(options));
    assert.equal(response.status, status, JSON.stringify(options));
    assert.equal(handler.calls.access, 1);
    for (const stage of ["read", "recipient", "pdf", "email", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
    assertPrivate(response);
  }
});

test("el alcance se consulta antes de resolver el correo y un contacto inválido impide generar o enviar el PDF", async () => {
  const forbidden = harness({ error: new CutCollectionError("Sede no autorizada.", 403) });
  const denied = await forbidden.POST(emailRequest());
  assert.equal(denied.status, 403);
  assert.deepEqual(forbidden.calls.read, [[access, filters]]);
  assert.deepEqual(forbidden.calls.order, ["access", "origin", "parse", "report"]);
  for (const stage of ["recipient", "pdf", "email"]) assert.equal(forbidden.calls[stage].length, 0);
  assertPrivate(denied);

  const noContact = harness({ recipientError: new CutCollectionError("El aliado no tiene un correo válido registrado.", 422) });
  const unavailable = await noContact.POST(emailRequest());
  assert.equal(unavailable.status, 422);
  assert.deepEqual(noContact.calls.order, ["access", "origin", "parse", "report", "recipient"]);
  assert.deepEqual(noContact.calls.recipient, [filters.aliadoId]);
  assert.equal(noContact.calls.pdf.length, 0);
  assert.equal(noContact.calls.email.length, 0);
  assertPrivate(unavailable);
});

test("correo envía una sola vez el PDF validado al contacto registrado e ignora destinatario, filtros y PDF del cuerpo", async () => {
  const handler = harness();
  const request = emailRequest({
    headers: { "content-type": "application/json; charset=UTF-8", "sec-fetch-site": "same-origin" },
    body: { recipient: "attacker@example.test", to: ["attacker@example.test"], cc: ["attacker@example.test"],
      aliadoId: 999, userId: 999, status: "todos", pdf: "forged-pdf", filename: "forged.pdf" },
  });
  const response = await handler.POST(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, recipient: registeredRecipient });
  assert.deepEqual(handler.calls.order, ["access", "origin", "parse", "report", "recipient", "pdf", "email"]);
  assert.deepEqual(handler.calls.read, [[access, filters]]);
  assert.deepEqual(handler.calls.recipient, [filters.aliadoId]);
  assert.deepEqual(handler.calls.pdf, [report]);
  assert.deepEqual(handler.calls.email, [{ recipient: registeredRecipient, pdf: pdfBytes, cutDate: report.cutDate,
    filename: "FINSERPAY_Recaudo_2026-10-17.pdf", idempotencyKey: `${access.userId}/${filters.aliadoId}/${requestKey}` }]);
  for (const stage of ["excel", "legacyRead", "save"]) assert.equal(handler.calls[stage].length, 0);
  assert.equal(request.bodyUsed, false, "El cuerpo no es una fuente de contenido ni destinatarios del envío");
  assertPrivate(response);
});

test("errores de correo, destinatario y PDF no exponen datos internos ni reintentan el envío", async () => {
  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args.join(" "));
  try {
    for (const [overrides, status, sends] of [
      [{ recipientError: new Error("SQL clienteDocumento=001234 secret-token") }, 500, 0],
      [{ pdfError: new Error("PDF clienteDocumento=001234 secret-token") }, 500, 0],
      [{ emailError: new Error("Resend private@example.test secret-token") }, 500, 1],
      [{ emailError: new CutCollectionError("Resend private@example.test secret-token", 502) }, 500, 1],
      [{ emailError: new CutCollectionError("Resend private@example.test secret-token", 503) }, 503, 1],
      [{ emailError: new CutCollectionEmailError("El proveedor de correo no aceptó el envío del informe.", 502) }, 502, 1],
      [{ emailError: new CutCollectionEmailError("No se pudo confirmar el envío. Verifica si el informe llegó antes de volver a enviarlo.", 503) }, 503, 1],
    ]) {
      const handler = harness(overrides);
      const response = await handler.POST(emailRequest());
      assert.equal(response.status, status);
      const payload = await response.json();
      assert.equal(typeof payload.error, "string");
      if (overrides.emailError instanceof CutCollectionEmailError) assert.equal(payload.error, overrides.emailError.message);
      assert.doesNotMatch(JSON.stringify(payload), /SQL|001234|secret-token|private@example/);
      assert.equal(handler.calls.email.length, sends);
      assert.equal(handler.calls.save.length, 0);
      assertPrivate(response);
    }
    assert.doesNotMatch(captured.join(" "), /SQL|001234|secret-token|private@example/);
  } finally { console.error = original; }
});

test("filtros y formatos inválidos o repetidos no consultan el reporte", async () => {
  for (const invalid of ["day=2&day=17", "format=xlsx&format=xlsx", "format=pdf&format=pdf", "format=csv", "format=", "day=3",
    "month=13", "year=1999", "aliadoId=-1", "sedeId=1.5", "status=invalid", "status=parcial&status=pagado"]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?${invalid}`));
    assert.equal(response.status, 400, invalid);
    assert.equal(handler.calls.read.length, 0);
    assertPrivate(response);
  }
});

test("errores de alcance, base de datos y timeout mantienen privacidad", async () => {
  const log = [];
  const original = console.error;
  console.error = (...args) => log.push(args.join(" "));
  try {
    for (const [error, status] of [
      [new Error("SQL clienteDocumento=001234 secret-token"), 500],
      [Object.assign(new Error("SQL private secret-token"), { code: "57014" }), 503],
      [new CutCollectionError("SQL private secret-token", 503), 503],
    ]) {
      const response = await harness({ error }).GET(new Request(url));
      assert.equal(response.status, status);
      assert.doesNotMatch(JSON.stringify(await response.json()), /SQL|001234|secret-token/);
      assertPrivate(response);
    }
    assert.doesNotMatch(log.join(" "), /SQL|001234|secret-token/);
  } finally { console.error = original; }
  const response = await harness({ error: new CutCollectionError("Sede no autorizada.", 403) }).GET(new Request(url));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Sede no autorizada.");
  assertPrivate(response);
});
