import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = new URL("../docs/integrations/diana-extension-requests/", import.meta.url);
const flow = JSON.parse(readFileSync(new URL("flow.draft.json", assets), "utf8"));
const action = JSON.parse(readFileSync(new URL("agent-action.draft.json", assets), "utf8"));
const code = readFileSync(new URL("normalize-action.js", assets), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": root,
  "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createDianaExtensionHandler } = await jiti.import("../lib/diana-extension-api.ts");
function normalize(body) {
  const sandboxModule = { exports: {} };
  runInNewContext(code, { params: { trigger: { body } }, module: sandboxModule });
  return JSON.parse(sandboxModule.exports.request_body);
}

test("la acción de Diana solo consulta CC y folio; no puede preparar ni autorizar una prórroga", () => {
  assert.equal(action.name, "gestionar_prorroga_finserpay");
  assert.equal(action.method, "POST");
  assert.deepEqual(action.parameters.map(parameter => parameter.name), ["cedula", "folio"]);
  assert.ok(action.parameters.every(parameter => parameter.type === "string" && parameter.required));
  const input = { cedula: "001234567", folio: "FC-TEST-1" };
  assert.deepEqual(normalize(input), { accion: "consultar_solicitud", ...input });
  assert.deepEqual(normalize({ args: input }), { accion: "consultar_solicitud", ...input });
  for (const extra of [{ accion: "aplicar" }, { dias: "4" }, { confirmed: true }, { messageId: "forged" }, { codigo: "forged" }]) {
    assert.throws(() => normalize({ ...input, ...extra }));
  }
  for (const invalid of [null, [], { ...input, cedula: 1234567 }, { ...input, folio: "FC/1" }, { args: input, confirmed: true }]) {
    assert.throws(() => normalize(invalid));
  }
});

test("el flujo conserva transporte dedicado y mapea únicamente resultados públicos", async () => {
  assert.equal(flow.api_nodes.length, 4);
  assert.equal(flow.timeout, 30);
  const trigger = flow.api_nodes.find(node => node.id === "prIn").api_trigger;
  assert.equal(trigger.trigger_type, "post");
  assert.deepEqual(trigger.trigger_params.map(parameter => parameter.key), ["cedula", "folio"]);
  assert.ok(trigger.trigger_params.every(parameter => parameter.origin === "body" && parameter.required));
  assert.equal(flow.api_nodes.find(node => node.id === "nrmPr").api_action.code_action.code, code.trimEnd());
  const http = flow.api_nodes.find(node => node.id === "qryPr").api_action;
  const legacy = JSON.parse(readFileSync(new URL("../docs/integrations/diana-extensions/flow.draft.json", import.meta.url), "utf8"));
  const legacyHttp = legacy.api_nodes.find(node => node.id === "qryPr").api_action;
  assert.ok(http.external_api_action, "el transporte HTTP debe existir");
  assert.equal(http.external_api_action.url, "https://finserpay.com/api/integraciones/diana/prorrogas");
  assert.equal(http.external_api_action.request_type, "post");
  assert.deepEqual(http.external_api_action, legacyHttp.external_api_action, "la URL, Bearer y cuerpo normalizado existentes se conservan");
  const fields = ["ok", "estado", "aprobada", "yaExistia", "dias", "cuotaNumero", "vencimientoCuota", "fechaLimite", "motivo"];
  assert.deepEqual(http.response, fields.map(key => ({ variable_name: key, response_value_path: `response.${key}` })));
  assert.deepEqual(flow.api_nodes.find(node => node.id === "rspPr").api_response.response_params.map(parameter => parameter.key), fields);

  const calls = [], token = "local-contract-token-not-a-production-credential";
  const handler = createDianaExtensionHandler({ token: () => token, enabled: () => false, requestEnabled: () => true,
    propose: async () => { throw new Error("read-only flow must not propose"); },
    status: async () => { throw new Error("read-only flow must not read legacy codes"); },
    requestStatus: async input => { calls.push(input); return { status: "GRANTED", approved: true, existing: false,
      days: 1, installmentNumber: 1, installmentDueDate: "2026-11-02", expiresOn: "2026-11-03", reason: null }; },
  });
  const result = await handler(new Request("https://finserpay.test/api/integraciones/diana/prorrogas", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(normalize({ cedula: "001234567", folio: "FC-TEST-1" })),
  }));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(Object.keys(body), fields);
  assert.equal(body.aprobada, true);
  assert.equal(body.fechaLimite, "2026-11-03");
  assert.deepEqual(calls, [{ cedula: "001234567", folio: "FC-TEST-1" }]);
});
