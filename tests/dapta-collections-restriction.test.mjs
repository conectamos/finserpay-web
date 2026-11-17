import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const http = await jiti.import("../lib/dapta-collections-http.ts");
const compile = name => ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helperCode = compile("collection-contact-restriction");
const integrationCode = compile("dapta-collections");

function load(code, dependencies, env) {
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, process: { env }, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return module.exports;
}

function setup({ document = "9000012345", enMora = true, history = [], excluded = "90.000.123-45" } = {}) {
  const env = { COLLECTION_CONTACT_EXCLUDED_DOCUMENTS: excluded,
    FINSERPAY_COBRANZA_API_TOKEN: "synthetic-collection-restriction-token-000000",
    FINSERPAY_COBRANZA_AGENT_ID: "synthetic-agent", FINSERPAY_COBRANZA_ACTOR_ID: "71" };
  const credit = { id: 81, numeroCreditoVisible: "SYNTHETIC-81", folio: "SYNTHETIC-FOLIO-81",
    clienteDocumento: document, valorVencido: 50000, diasMora: 3, ultimoPago: null, enMora };
  const writes = [];
  const helper = load(helperCode, { "server-only": {} }, env);
  const { collectionsHandlers } = load(integrationCode, {
    "server-only": {}, "@/lib/dapta-collections-http": http,
    "@/lib/collection-contact-restriction": helper,
    "@/lib/analyst-mora-management": {
      getMoraManagement: async id => { assert.equal(id, credit.id); return { credit, history }; },
      parseMoraManagement: input => input,
      createMoraManagement: async (id, input, actor) => { writes.push({ id, input, actor }); return { item: { id: "synthetic-history-event" } }; },
    },
    "@/lib/credit-approval-http": { approvalErrorResponse: error => { throw error; } },
  }, env);
  const request = body => new Request("https://finserpay.invalid/api/integraciones/cobranza/creditos", {
    method: "POST", headers: { authorization: `Bearer ${env.FINSERPAY_COBRANZA_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const read = async () => { const response = await collectionsHandlers.consulta(request({ creditoId: 81 })); assert.equal(response.status, 200); return response.json(); };
  return { read, env, writes, credit, history, handlers: collectionsHandlers, request };
}

test("Dapta suspends restricted customer collection while preserving authentic debt and history", async () => {
  const history = [{ id: "synthetic-existing-history", managementStatus: "SIN_RESPUESTA", resultCode: "SIN_RESPUESTA", comment: "Synthetic prior attempt" }];
  const f = setup({ history });
  const result = await f.read();
  assert.equal(result.suspenderCobranza, true);
  assert.equal(result.acuerdoVigente, false);
  assert.deepEqual(result.ultimaGestion, history[0]);
  assert.deepEqual(result.credito, { id: 81, numero: "SYNTHETIC-81", folio: "SYNTHETIC-FOLIO-81", valorVencido: 50000, diasMora: 3, ultimoPago: null, enMora: true });
  assert.equal(result.bloqueoAplica, null);
  assert.equal(result.reporteHabilitado, null);
  assert.equal(f.writes.length, 0);
});

test("another customer remains collectible and no history is fabricated", async () => {
  const f = setup({ document: "9000012346" });
  const result = await f.read();
  assert.equal(result.suspenderCobranza, false);
  assert.equal(result.acuerdoVigente, false);
  assert.equal(result.ultimaGestion, null);
  assert.equal(f.writes.length, 0);
});

test("existing paid, current-agreement and reported-payment suspension rules stay intact", async () => {
  for (const input of [
    { enMora: false },
    { history: [{ id: "synthetic-agreement", managementStatus: "ACUERDO_PAGO", resultCode: "ACUERDO_PAGO" }] },
    { history: [{ id: "synthetic-payment", managementStatus: "SEGUIMIENTO", resultCode: "PAGO_REALIZADO" }] },
  ]) {
    const f = setup({ ...input, excluded: "" });
    assert.equal((await f.read()).suspenderCobranza, true);
    assert.equal(f.writes.length, 0);
  }
});

test("the integration uses the real helper against the current environment", async () => {
  const f = setup({ excluded: "" });
  assert.equal((await f.read()).suspenderCobranza, false);
  f.env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = "90 000 123 45";
  assert.equal((await f.read()).suspenderCobranza, true);
  f.env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = "CC9000012345";
  assert.equal((await f.read()).suspenderCobranza, false);
  delete f.env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS;
  assert.equal((await f.read()).suspenderCobranza, false);
  assert.equal(f.writes.length, 0);
});

test("restriction does not discard an authenticated record of an actual completed collection action", async () => {
  const f = setup();
  const response = await f.handlers.gestion(f.request({ creditoId: 81, agentId: "synthetic-agent", callId: "synthetic-call-81",
    actedAt: "2026-11-16T15:00:00.000Z", result: "SIN_RESPUESTA", comment: "Synthetic authentic provider closure",
    nextFollowUpAt: "2026-11-17T15:00:00.000Z" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).registrado, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].id, 81);
  assert.equal(f.writes[0].input.result, "SIN_RESPUESTA");
  assert.equal(f.writes[0].input.action, "LLAMADA");
  assert.equal(f.writes[0].actor.id, 71);
  assert.equal(f.writes[0].actor.centralAdmin, false);
});
