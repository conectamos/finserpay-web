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
const automaticAnalysis = {
  ok: true, cutDate: report.cutDate, asOf: "2026-11-06T20:00:00.000Z", filters: { ...filters, status: "todos" },
  collectionBasis: { mode: "current_accumulated", sameAgeAvailable: false, referenceAgeDays: 20, reason: "NO_COMPLETE_HISTORICAL_LEDGER" },
  cuts: [{ cutDate: report.cutDate, ageDays: 20, summary: null, earlyRisk: [], unavailableCredits: 0 }],
  priorities: { allies: [], sites: [] }, warnings: [],
};
const pdfBytes = Buffer.from("%PDF-local-http-fixture");
const registeredRecipient = "aliado-registrado@example.test";
const registeredWhatsApp = "573001234567";
const requestKey = "1d34cc6f-8bf8-4277-b1a4-2f908a6ca9ab";
const riskCuts = ["2026-08-02", "2026-10-17", "2026-09-17"];
const sixRiskCuts = [...riskCuts, "2000-01-02", "2200-12-17", "2026-07-02"];
const comparisonFor = dates => dates.map((cutDate, index) => ({ cutDate, queriedAt: "2026-11-06T20:00:00.000Z",
  earlyRisk: [{ label: "FPD 7", cases: index + 1, eligible: 10, pending: 2, unavailable: 0 }] }));
class CutCollectionEmailError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
class CutCollectionWhatsAppError extends Error {
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
  const calls = { access: 0, parse: [], read: [], risk: [], analysis: [], legacyRead: [], save: [], excel: [], origin: [], pdf: [], pdfComparisons: [], recipient: [], email: [], whatsapp: [], order: [] };
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
      getDirectCutAutomaticAnalysis: async (...args) => {
        calls.analysis.push(args);
        calls.order.push("analysis");
        if (overrides.analysisError) throw overrides.analysisError;
        return automaticAnalysis;
      },
      getDirectCutRiskComparison: async (...args) => {
        calls.risk.push(args); calls.order.push("risk");
        if (overrides.riskError) throw overrides.riskError;
        return comparisonFor(args[2]);
      },
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
      buildCutCollectionPdf: async (value, comparison) => {
        calls.pdf.push(value); calls.pdfComparisons.push(comparison); calls.order.push("pdf");
        if (overrides.pdfError) throw overrides.pdfError;
        return pdfBytes;
      },
    };
    if (name === "@/lib/cut-collection-email") return {
      CutCollectionEmailError,
      getCutCollectionRecipient: async id => { calls.recipient.push(id); calls.order.push("recipient"); if (overrides.recipientError) throw overrides.recipientError; return registeredRecipient; },
      sendCutCollectionEmail: async input => { calls.email.push(input); calls.order.push("email"); if (overrides.emailError) throw overrides.emailError; },
    };
    if (name === "@/lib/cut-collection-whatsapp") return {
      CutCollectionWhatsAppError,
      sendCutCollectionWhatsApp: async input => {
        calls.whatsapp.push(input); calls.order.push("whatsapp");
        if (overrides.whatsappError) throw overrides.whatsappError;
        return registeredWhatsApp;
      },
    };
    assert.fail(`Dependencia no aislada: ${name}`);
  }
  return { ...compile("app/api/reportes/recaudo-por-corte/route.ts", scopedRequire), calls };
}

function deliveryRequest({ headers = {}, params = query.toString(), body = {}, action = "email" } = {}) {
  const merged = new Headers({ origin: new URL(url).origin, "content-type": "application/json", "idempotency-key": requestKey });
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) merged.delete(key);
    else merged.set(key, value);
  }
  return new Request(`${url}?${params}&action=${action}`, { method: "POST", headers: merged, body: JSON.stringify(body) });
}
const emailRequest = options => deliveryRequest({ ...options, action: "email" });
const whatsappRequest = options => deliveryRequest({ ...options, action: "whatsapp" });

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("el análisis automático es una consulta privada y conserva el alcance autorizado", async () => {
  const request = new Request(`${url}?${query}&format=analysis`);
  const { GET, calls } = harness();
  const response = await GET(request);
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.deepEqual(await response.json(), automaticAnalysis);
  assert.deepEqual(calls.analysis, [[access, filters]]);
  assert.deepEqual(calls.order, ["access", "parse", "analysis"]);
  assert.equal(calls.read.length + calls.save.length + calls.risk.length + calls.whatsapp.length, 0);

  const blocked = harness({ analysisError: new CutCollectionError("La sede no está autorizada.", 403) });
  const denied = await blocked.GET(request);
  assert.equal(denied.status, 403);
  assertPrivate(denied);
  assert.deepEqual(await denied.json(), { error: "La sede no está autorizada." });
});

test("GET y POST exigen sesión y permisos antes de consultar o rechazar la operación retirada", async () => {
  for (const status of [401, 403]) {
    const handler = harness({ accessError: new CutCollectionError("Sin acceso", status) });
    for (const response of [await handler.GET(new Request(url)), await handler.POST(new Request(url, { method: "POST" })),
      await handler.GET(new Request(`${url}?${query}&format=pdf`)),
      await handler.GET(new Request(`${url}?${query}&format=risk&riskCuts=${riskCuts.join(",")}`)),
      await handler.POST(emailRequest()), await handler.POST(whatsappRequest())]) {
      assert.equal(response.status, status);
      assertPrivate(response);
    }
    assert.equal(handler.calls.read.length, 0);
    assert.equal(handler.calls.legacyRead.length, 0);
    assert.equal(handler.calls.save.length, 0);
    for (const stage of ["origin", "parse", "risk", "recipient", "pdf", "email", "whatsapp"]) assert.equal(handler.calls[stage].length, 0);
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
  assert.deepEqual(handler.calls.pdfComparisons, [undefined]);
  assert.equal(handler.calls.risk.length, 0, "El PDF sin riskCuts conserva el comportamiento anterior");
  for (const stage of ["excel", "recipient", "email", "legacyRead", "save"]) assert.equal(handler.calls[stage].length, 0);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="FINSERPAY_Recaudo_2026-10-17.pdf"');
  assert.equal(response.headers.get("content-length"), String(pdfBytes.byteLength));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);
  assertPrivate(response);
});

test("format=risk consulta hasta seis cortes en orden manual con alcance y filtros comunes sin depender de proyecciones", async () => {
  const dates = sixRiskCuts;
  assert.equal(dates.join(",").length, 65);
  for (const status of ["todos", "pendiente", "parcial", "pagado"]) {
    const handler = harness();
    const params = new URLSearchParams(query);
    params.set("status", status);
    params.set("format", "risk");
    params.set("riskCuts", dates.join(","));
    params.set("projectionId", "old-invalid-id");
    params.set("historyPage", "old-invalid-page");
    const response = await handler.GET(new Request(`${url}?${params}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reports: comparisonFor(dates) });
    assert.deepEqual(handler.calls.risk, [[access, { ...filters, status }, dates]]);
    for (const stage of ["read", "pdf", "excel", "email", "whatsapp", "legacyRead", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
    assert.equal("projectionId" in handler.calls.parse[0], false);
    assertPrivate(response);
  }
  const selected = harness();
  const response = await selected.GET(new Request(`${url}?${query}&format=risk`));
  assert.deepEqual(await response.json(), { reports: comparisonFor([report.cutDate]) });
  assert.deepEqual(selected.calls.risk, [[access, filters, [report.cutDate]]]);
});

test("riskCuts inválidos o repetidos se rechazan antes de consultar o enviar en todos los formatos de riesgo", async () => {
  for (const value of [
    "", "2026-11-02,2026-11-02", "2026-01-02,2026-02-02,2026-03-02,2026-04-02,2026-05-02,2026-06-02,2026-07-02",
    "2026-11-03", "2026-02-30", "2026-13-02", "2026-00-17", "2026-1-02", "2026-11-2",
    "1999-12-17", "2201-01-02", "2026-11-02T00:00:00Z", "2026-11-02,", " 2026-11-02",
  ]) {
    const params = new URLSearchParams(query);
    params.set("riskCuts", value);
    for (const mode of ["risk", "pdf", "email", "whatsapp"]) {
      const handler = harness();
      const response = mode === "risk" || mode === "pdf"
        ? await handler.GET(new Request(`${url}?${params}&format=${mode}`))
        : await handler.POST(deliveryRequest({ action: mode, params: params.toString() }));
      assert.equal(response.status, 400, `${mode}: ${value}`);
      for (const stage of ["read", "risk", "recipient", "pdf", "email", "whatsapp", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
      assertPrivate(response);
    }
  }
  const repeated = harness();
  const response = await repeated.GET(new Request(`${url}?${query}&format=risk&riskCuts=2026-11-02&riskCuts=2026-11-17`));
  assert.equal(response.status, 400);
  assert.equal(repeated.calls.risk.length, 0);
});

test("PDF, correo y WhatsApp preservan el orden manual de seis cortes y los filtros del reporte", async () => {
  const params = `${query}&riskCuts=${sixRiskCuts.join(",")}`;
  const comparison = comparisonFor(sixRiskCuts);
  for (const mode of ["pdf", "email", "whatsapp"]) {
    const handler = harness();
    const response = mode === "pdf"
      ? await handler.GET(new Request(`${url}?${params}&format=pdf`))
      : await handler.POST(deliveryRequest({ action: mode, params,
        body: { riskCuts: ["2026-12-17"], comparison: [{ cutDate: "2026-12-17", earlyRisk: [] }], recipient: "forged@example.test" } }));
    assert.equal(response.status, 200);
    assert.deepEqual(handler.calls.read, [[access, filters]]);
    assert.deepEqual(handler.calls.risk, [[access, filters, sixRiskCuts]]);
    if (mode === "whatsapp") {
      assert.deepEqual(handler.calls.whatsapp, [{ userId: access.userId, key: requestKey, allyId: filters.aliadoId, report, comparison }]);
      assert.equal(handler.calls.pdf.length, 0);
      assert.equal(handler.calls.email.length, 0);
    } else {
      assert.deepEqual(handler.calls.pdf, [report]);
      assert.deepEqual(handler.calls.pdfComparisons, [comparison]);
      assert.equal(handler.calls.email.length, mode === "email" ? 1 : 0);
      assert.equal(handler.calls.whatsapp.length, 0);
    }
    assertPrivate(response);
  }
});

test("riskCuts no cambia el JSON financiero ni Excel ni añade consultas de riesgo a esos formatos", async () => {
  for (const format of ["", "&format=xlsx"]) {
    const handler = harness();
    const response = await handler.GET(new Request(`${url}?${query}&riskCuts=${riskCuts.join(",")}${format}`));
    assert.equal(response.status, 200);
    assert.deepEqual(handler.calls.read, [[access, filters]]);
    assert.equal(handler.calls.risk.length, 0);
    if (format) assert.deepEqual(handler.calls.excel, [report]);
    else assert.deepEqual(await response.json(), report);
    assertPrivate(response);
  }
});

test("PDF y asunto de correo identifican el corte explícito o los extremos cronológicos de la comparación", async () => {
  for (const [dates, period, suffix] of [
    [["2026-08-02"], "2026-08-02", "2026-08-02"],
    [["2026-10-17", "2026-08-02", "2026-09-17"], "2026-08-02 a 2026-10-17", "2026-08-02_a_2026-10-17"],
  ]) {
    const params = `${query}&riskCuts=${dates.join(",")}`;
    const filename = `FINSERPAY_Riesgo_${suffix}.pdf`;
    const pdf = harness();
    const downloaded = await pdf.GET(new Request(`${url}?${params}&format=pdf`));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-disposition"), `attachment; filename="${filename}"`);
    assert.deepEqual(pdf.calls.pdfComparisons, [comparisonFor(dates)], "Nombrar cronológicamente no cambia el orden solicitado");
    const email = harness();
    const sent = await email.POST(emailRequest({ params }));
    assert.equal(sent.status, 200);
    assert.equal(email.calls.email[0].filename, filename);
    assert.equal(email.calls.email[0].cutDate, period, "El asunto usa los cortes comparados, no el corte financiero principal");
    assert.deepEqual(email.calls.risk, [[access, filters, dates]]);
  }
});

test("un alcance denegado en la comparación bloquea PDF y ambos envíos antes de resolver destinatarios", async () => {
  for (const mode of ["risk", "pdf", "email", "whatsapp"]) {
    const handler = harness({ riskError: new CutCollectionError("Sede no autorizada.", 403) });
    const params = `${query}&riskCuts=${riskCuts.join(",")}`;
    const response = mode === "risk" || mode === "pdf"
      ? await handler.GET(new Request(`${url}?${params}&format=${mode}`))
      : await handler.POST(deliveryRequest({ action: mode, params }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Sede no autorizada." });
    assert.deepEqual(handler.calls.risk, [[access, filters, riskCuts]]);
    for (const stage of ["recipient", "pdf", "email", "whatsapp", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
    assertPrivate(response);
  }
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

test("enviar correo o WhatsApp exige origen propio, JSON, UUID v4, filtros válidos y un aliado explícito", async () => {
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
    for (const action of ["email", "whatsapp"]) {
      const handler = harness();
      const response = await handler.POST(deliveryRequest({ ...options, action }));
      assert.equal(response.status, status, JSON.stringify({ ...options, action }));
      assert.equal(handler.calls.access, 1);
      for (const stage of ["read", "recipient", "pdf", "email", "whatsapp", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
      assertPrivate(response);
    }
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

test("WhatsApp recibe una sola vez el aliado autorizado y devuelve el contacto registrado sin aceptar números del navegador", async () => {
  const handler = harness();
  const request = whatsappRequest({
    params: `${query}&phone=573999999999&recipient=573888888888&userId=999&central=true`,
    body: { phone: "573999999999", recipient: "573888888888", clienteTelefono: "573777777777",
      telefonoWhatsapp: "573666666666", aliadoId: 999, userId: 999, pdf: "forged-pdf", fallback: "email" },
  });
  const response = await handler.POST(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, recipient: registeredWhatsApp });
  assert.deepEqual(handler.calls.order, ["access", "origin", "parse", "report", "whatsapp"]);
  assert.deepEqual(handler.calls.read, [[access, filters]]);
  assert.deepEqual(handler.calls.whatsapp, [{ userId: access.userId, key: requestKey, allyId: filters.aliadoId, report }]);
  for (const stage of ["recipient", "email", "pdf", "excel", "legacyRead", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
  assert.equal(request.bodyUsed, false);
  assertPrivate(response);
});

test("WhatsApp valida el alcance antes de invocar el servicio y no usa otro canal si falta el número registrado", async () => {
  const forbidden = harness({ error: new CutCollectionError("Aliado no autorizado.", 403) });
  const denied = await forbidden.POST(whatsappRequest());
  assert.equal(denied.status, 403);
  assert.deepEqual(forbidden.calls.order, ["access", "origin", "parse", "report"]);
  assert.equal(forbidden.calls.whatsapp.length, 0);
  assertPrivate(denied);

  const missingNumber = harness({ whatsappError: new CutCollectionError("El aliado no tiene un número de WhatsApp válido registrado.", 422) });
  const response = await missingNumber.POST(whatsappRequest({ body: { phone: "573999999999", fallback: "email" } }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "El aliado no tiene un número de WhatsApp válido registrado." });
  assert.deepEqual(missingNumber.calls.whatsapp, [{ userId: access.userId, key: requestKey, allyId: filters.aliadoId, report }]);
  for (const handler of [forbidden, missingNumber]) {
    for (const stage of ["recipient", "email", "pdf", "excel", "legacyRead", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
  }
  assertPrivate(response);
});

test("WhatsApp conserva errores seguros, oculta fallos internos y no reintenta ni deriva a correo", async () => {
  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args.join(" "));
  try {
    for (const [error, status] of [
      [new CutCollectionWhatsAppError("La solicitud corresponde a otro informe.", 409), 409],
      [new CutCollectionWhatsAppError("WhatsApp rechazó el envío del informe.", 502), 502],
      [new CutCollectionWhatsAppError("WhatsApp no confirmó el envío. Verifica si llegó antes de volver a enviarlo.", 503), 503],
      [new Error("SQL clienteDocumento=001234 secret-token graph.facebook.com 573999999999"), 500],
      [new CutCollectionError("SQL secret-token 573999999999", 503), 503],
    ]) {
      const handler = harness({ whatsappError: error });
      const response = await handler.POST(whatsappRequest());
      assert.equal(response.status, status);
      const payload = await response.json();
      assert.deepEqual(Object.keys(payload), ["error"]);
      if (error instanceof CutCollectionWhatsAppError) assert.equal(payload.error, error.message);
      assert.doesNotMatch(JSON.stringify(payload), /SQL|001234|secret-token|graph\.facebook|573999999999|wa\.me/);
      assert.equal(handler.calls.whatsapp.length, 1);
      for (const stage of ["recipient", "email", "pdf", "save"]) assert.equal(handler.calls[stage].length, 0, stage);
      assertPrivate(response);
    }
    assert.doesNotMatch(captured.join(" "), /SQL|001234|secret-token|573999999999/);
  } finally { console.error = original; }
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
