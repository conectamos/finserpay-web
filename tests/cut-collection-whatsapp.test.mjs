import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const { CutCollectionError } = await jiti.import("../lib/cut-collection-access.ts");
const contacts = await jiti.import("../lib/ally-contact.ts");
const source = readFileSync(new URL("../lib/cut-collection-whatsapp.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const payload = {
  userId: 5, key: "8fb5b2a9-d59b-40c5-aba7-4de92b2d125e", allyId: 1,
  report: { cutDate: "2026-11-02", filters: { aliadoId: 1 } },
};

function harness({ pending = false, networkFailure = false, missingPhone = false } = {}) {
  const requests = [];
  const sent = [];
  const rendered = [];
  let row;
  const database = {
    aliado: { findUnique: async () => ({ activo: true, telefonoWhatsapp: missingPhone ? null : "3001234567" }) },
    $queryRaw: async () => row ? [row] : [],
    $executeRaw: async (parts, ...values) => {
      const sql = parts.join("?");
      if (sql.includes("INSERT INTO")) {
        if (row) return 0;
        row = { scopeHash: values[2], state: "SENDING" };
      } else {
        row.state = sql.includes("'ACCEPTED'") ? "ACCEPTED" : "REJECTED";
      }
      return 1;
    },
  };
  const compiledModule = { exports: {} };
  const deps = {
    "./prisma": { __esModule: true, default: database },
    "./cut-collection-access": { CutCollectionError },
    "./ally-contact": contacts,
    "./cut-collection-pdf": { buildCutCollectionPdf: async (...args) => {
      rendered.push(args);
      return Buffer.from("%PDF-synthetic");
    } },
  };
  const fetcher = async (url, options) => {
    requests.push(url);
    const api = compiledModule.exports;
    if (url.includes("fields=display_phone_number")) return Response.json({ display_phone_number: "+57 312 4085562" });
    if (url.includes("message_templates")) return Response.json({ data: [{
      name: api.RISK_WHATSAPP_TEMPLATE, status: pending ? "PENDING" : "APPROVED", language: api.RISK_WHATSAPP_LANGUAGE,
      components: [{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: api.RISK_WHATSAPP_BODY }],
    }] });
    if (url.endsWith("/media")) {
      assert.equal(options.body.get("file").type, "application/pdf");
      return Response.json({ id: "123456789" });
    }
    if (url.endsWith("/messages")) {
      sent.push(JSON.parse(options.body));
      if (networkFailure) throw new Error("network");
      return Response.json({ messages: [{ id: "wamid.test" }] });
    }
    throw new Error("Unexpected provider URL");
  };
  new Function("require", "module", "exports", "process", "fetch", compiled)(
    name => deps[name] ?? require(name), compiledModule, compiledModule.exports,
    { env: { WHATSAPP_ATTENTION_ACCESS_TOKEN: "test-only", WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: "12345678",
      WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID: "12345679" } }, fetcher,
  );
  return { send: compiledModule.exports.sendCutCollectionWhatsApp, requests, sent, rendered };
}

test("envía solo al contacto registrado y una repetición de la misma llave no reenvía", async () => {
  const { send, sent, requests } = harness();
  assert.equal(await send(payload), "573001234567");
  assert.equal(await send(payload), "573001234567");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "573001234567");
  assert.equal(sent[0].template.components[0].parameters[0].document.id, "123456789");
  assert.equal(requests.length, 4);
});

test("envía un solo PDF con la selección y la llave impide cambiar sus cortes", async () => {
  const { send, sent, rendered } = harness();
  const comparison = ["2026-10-02", "2026-10-17", "2026-11-02"].map(cutDate => ({ cutDate, earlyRisk: [] }));
  await send({ ...payload, comparison });
  assert.deepEqual(rendered, [[payload.report, comparison]]);
  assert.equal(sent[0].template.components[0].parameters[0].document.filename, "FINSERPAY_Riesgo_2026-10-02_a_2026-11-02.pdf");
  await assert.rejects(send({ ...payload, comparison: comparison.slice(1) }), error => error.status === 409);
  assert.equal(sent.length, 1);
});

test("una plantilla pendiente nunca sube el PDF ni intenta enviar", async () => {
  const { send, sent, requests } = harness({ pending: true });
  await assert.rejects(send(payload), error => error.status === 503 && /aprobada/.test(error.message));
  assert.equal(sent.length, 0);
  assert.equal(requests.length, 2);
});

test("una respuesta incierta conserva la llave bloqueada para impedir duplicados", async () => {
  const { send, sent } = harness({ networkFailure: true });
  await assert.rejects(send(payload), error => error.status === 503);
  await assert.rejects(send(payload), error => error.status === 409);
  assert.equal(sent.length, 1);
});

test("un aliado sin número válido no contacta a Meta", async () => {
  const { send, requests } = harness({ missingPhone: true });
  await assert.rejects(send(payload), error => error.status === 422);
  assert.equal(requests.length, 0);
});
