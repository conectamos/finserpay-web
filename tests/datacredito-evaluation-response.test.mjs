import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const routeSource = readFileSync(new URL("../app/api/creditos/datacredito/evaluaciones/route.ts", import.meta.url), "utf8");
const helpersSource = routeSource.slice(
  routeSource.indexOf("function technicalResponse("),
  routeSource.indexOf("function safeProviderValue(")
);

function fixture({ markingError = null } = {}) {
  const calls = [];
  const warnings = [];
  class SolicitudDataCreditoLinkError extends Error {
    code = "SOLICITUD_NOT_AVAILABLE";
    status = 409;
  }
  const compiled = ts.transpileModule(`${helpersSource}\nexport { technicalResponse, solicitudTechnicalResponse, solicitudRecoverableResponse };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  const mark = async input => {
    calls.push(input);
    if (markingError === "link") throw new SolicitudDataCreditoLinkError("No disponible");
  };
  runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    markSolicitudDataCreditoTechnicalError: mark,
    markSolicitudDataCreditoRecoverablePending: mark,
    SolicitudDataCreditoLinkError,
    console: { warn: (...values) => warnings.push(values) },
  });
  return { ...loaded.exports, calls, warnings };
}

test("los bloqueos conservan la solicitud para retomar el expediente sin otra consulta", async () => {
  for (const [helper, code] of [
    ["solicitudTechnicalResponse", "ASSESSMENT_REQUIRES_REVIEW"],
    ["solicitudRecoverableResponse", "EVALUATION_IN_PROGRESS"],
  ]) {
    const f = fixture();
    const response = await f[helper]({
      correlationId: "tracking-only", code, error: "No se hizo otra consulta", status: 409,
      solicitudId: 2876, plataforma: "IPHONE",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false, status: "NO_EVALUADO", error: "No se hizo otra consulta", code,
      correlationId: "tracking-only", solicitudId: 2876,
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].solicitudId, 2876);
    assert.equal(f.calls[0].errorCode, code);
  }
});

test("el diagnóstico registra únicamente correlación, código y estado HTTP", async () => {
  const f = fixture();
  const response = f.technicalResponse({
    correlationId: "tracking-only", code: "INVALID_REQUEST", status: 400,
    error: "Texto privado del cliente 12345678", solicitudId: 2876,
  });
  assert.equal(response.status, 400);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0][0], "DATACREDITO_EVALUATION_RESPONSE");
  assert.deepEqual(JSON.parse(JSON.stringify(f.warnings[0][1])), {
    correlationId: "tracking-only", code: "INVALID_REQUEST", status: 400,
  });
  assert.doesNotMatch(JSON.stringify(f.warnings), /privado|12345678|2876/);
  const withoutDraft = await f.technicalResponse({
    correlationId: "other-tracking", code: "INVALID_REQUEST", status: 400, error: "Solicitud inválida",
  }).json();
  assert.equal("solicitudId" in withoutDraft, false);
});

test("un error controlado de enlace conserva la solicitud conocida en ambas respuestas", async () => {
  for (const helper of ["solicitudTechnicalResponse", "solicitudRecoverableResponse"]) {
    const f = fixture({ markingError: "link" });
    const response = await f[helper]({
      correlationId: "tracking-only", code: "EVALUATION_IN_PROGRESS", status: 409,
      error: "En proceso", solicitudId: 2876,
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.solicitudId, 2876);
    assert.equal(body.code, "SOLICITUD_NOT_AVAILABLE");
  }
});
