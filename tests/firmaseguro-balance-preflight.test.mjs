import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const providerSource = readFileSync(new URL("../lib/firmaseguro.ts", import.meta.url), "utf8");
const creditSource = readFileSync(new URL("../lib/firmaseguro-credit.ts", import.meta.url), "utf8");
const prepareStart = creditSource.indexOf("export async function prepareFirmaSeguroReissue(");
const prepareSource = creditSource.slice(prepareStart,
  creditSource.indexOf("export async function createFirmaSeguroProcessForCredit(", prepareStart));
const config = { nit: "900000001", balanceTypeId: 2, signatureMethodId: 2 };
const pool = (amount = 3, values = {}) => ({
  balanceTypeId: 2, signatureMethodsId: [2],
  authenticationMethods: ["OTP Email", "OTP SMS", "OTP Whatsapp"], amount, ...values,
});
const balance = (transactions = [pool()], values = {}) => ({ nit: config.nit, transactions, ...values });

function provider(reply = () => Response.json(balance())) {
  const requests = [];
  const api = runInNewContext(stripTypeScriptTypes(providerSource.replace(/^export /gm, ""))
    + "\n({assertFirmaSeguroDispatchBalance, FirmaSeguroBalancePreflightError, firmaSeguroCreateFull, firmaSeguroCreateFullByCompany});", {
    Buffer, URL, AbortSignal, console: { error() {} },
    process: { env: { FIRMASEGURO_BASE_URL: "https://firmaseguro.example.test" } },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return reply(url, options);
    },
  });
  return { ...api, requests };
}

function preparer(api, useCompanyEndpoint = false) {
  let built = 0;
  const effective = { ...config, useCompanyEndpoint, callbackSecret: "fixture-secret" };
  const prepare = runInNewContext(stripTypeScriptTypes(prepareSource.replace(/^export /gm, ""))
    + "\nprepareFirmaSeguroReissue;", {
    Buffer, ...api, Error,
    isFirmaSeguroConfigured: () => true,
    buildFirmaSeguroCallbackUrl: () => "https://finserpay.example.test/callback",
    getFirmaSeguroConfig: () => effective,
    buildDraftSignatureCallbackUrl: (_url, id) => `https://finserpay.example.test/callback?dispatch=${id}`,
    splitClientName: () => ({ document: "1000000001" }),
    getFirmaSeguroDelivery: () => ({ sendByWhatsApp: true, authMethodId: 4 }),
    firmaSeguroSignIn: async () => ({ token: "synthetic-token" }),
    resolveFirmaSeguroDeliveryAuth: async (_token, delivery) => delivery,
    buildCreateFullPayload: () => { built++; return { signatureMethodId: 2, balanceTypeId: 2, tags: [] }; },
    buildCreateFullByCompanyPayload: () => { built++; return { process: { signature_method_id: 2, balance_type_id: 2, tags: [] } }; },
    redactBase64Payload: value => value,
    extractFirmaSeguroUuid: value => value.uuid,
    extractFirmaSeguroStatus: value => value.status,
  });
  return { effective, built: () => built,
    prepare: () => prepare({}, Buffer.from("%PDF-1.7 synthetic"), "a".repeat(36), { callbackScope: "draft_dispatch" }) };
}

test("valida el cupo exacto configurado mediante GET acotado sin modificar los métodos", async () => {
  const api = provider(() => Response.json(balance([
    pool(0, { balanceTypeId: 1 }), pool(0, { signatureMethodsId: [1] }), pool(3),
  ])));
  const original = structuredClone(config);
  await api.assertFirmaSeguroDispatchBalance("synthetic-token", config);
  assert.deepEqual(config, original);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].method, "GET");
  assert.equal(api.requests[0].url, `https://firmaseguro.example.test/api/v2/Balance/balance-by-nit/${config.nit}`);
  assert.equal(api.requests[0].body, undefined);
  assert.ok(api.requests[0].signal instanceof AbortSignal);
});

for (const amount of [0, -1]) {
  test(`el cupo confirmado ${amount} impide crear un contrato en ambos endpoints`, async () => {
    for (const company of [false, true]) {
      const api = provider(() => Response.json(balance([pool(amount)])));
      const f = preparer(api, company);
      await assert.rejects(f.prepare(), error => {
        assert.equal(error.code, "FIRMASEGURO_BALANCE_INSUFFICIENT");
        assert.match(error.message, /El contrato no se envió/);
        return true;
      });
      assert.equal(f.built(), 0);
      assert.equal(api.requests.length, 1);
      assert.equal(api.requests[0].method, "GET");
      assert.equal(f.effective.balanceTypeId, 2);
      assert.equal(f.effective.signatureMethodId, 2);
    }
  });
}

const unverifiedResponses = [
  null, {}, [], { data: balance() }, balance([], { nit: "900000002" }),
  balance([]), balance([pool(3, { balanceTypeId: 1 })]),
  balance([pool(3, { signatureMethodsId: [1] })]),
  balance([pool(3, { signatureMethodsId: ["2"] })]),
  balance([pool(3), pool(0)]), balance([pool("3")]),
  balance([pool(null)]), balance([pool(3, { signatureMethodsId: null })]),
];
for (const [index, response] of unverifiedResponses.entries()) {
  test(`la respuesta de cupo incompleta, ajena o ambigua ${index + 1} falla antes del envío`, async () => {
    const api = provider(() => Response.json(response));
    const f = preparer(api);
    await assert.rejects(f.prepare(), { code: "FIRMASEGURO_BALANCE_UNVERIFIED" });
    assert.equal(f.built(), 0);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "GET");
  });
}

test("configuración sin NIT o pool válido falla sin consultar ni crear", async () => {
  const api = provider(() => assert.fail("No debe consultar con configuración incompleta"));
  for (const invalid of [{ ...config, nit: null }, { ...config, balanceTypeId: 0 },
    { ...config, signatureMethodId: "2" }]) {
    await assert.rejects(api.assertFirmaSeguroDispatchBalance("synthetic-token", invalid),
      { code: "FIRMASEGURO_BALANCE_UNVERIFIED" });
  }
  assert.equal(api.requests.length, 0);
});

for (const failure of [
  () => Response.json({ detail: "private-provider-diagnostic" }, { status: 500 }),
  () => { throw new Error("private-provider-timeout"); },
]) {
  test("un fallo al leer saldo conserva un error de preparación fijo y nunca crea procesos", async () => {
    const api = provider(failure);
    const f = preparer(api);
    await assert.rejects(f.prepare(), error => {
      assert.equal(error.code, "FIRMASEGURO_BALANCE_UNVERIFIED");
      assert.doesNotMatch(error.message, /private-provider|HTTP|api\/v2/);
      return true;
    });
    assert.equal(f.built(), 0);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "GET");
  });
}

test("el cupo positivo permite un único POST explícito con el mismo endpoint y métodos", async () => {
  for (const company of [false, true]) {
    const api = provider((_url, options) => options.method === "GET"
      ? Response.json(balance()) : Response.json({ uuid: "synthetic-process", status: "CREATED" }));
    const f = preparer(api, company);
    const prepared = await f.prepare();
    assert.equal(api.requests.length, 1, "la preparación consulta saldo sin enviar");
    const result = await prepared.sendOnce();
    assert.equal(result.processUuid, "synthetic-process");
    assert.equal(api.requests.length, 2);
    const request = api.requests[1];
    assert.equal(request.method, "POST");
    assert.ok(request.url.endsWith(company ? "/create-full-by-company" : "/create-full"));
    const payload = JSON.parse(request.body);
    assert.equal(company ? payload.process.balance_type_id : payload.balanceTypeId, 2);
    assert.equal(company ? payload.process.signature_method_id : payload.signatureMethodId, 2);
    await assert.rejects(prepared.sendOnce(), /REISSUE_ALREADY_DISPATCHED/);
    assert.equal(api.requests.length, 2);
  }
});

test("saldo positivo no convierte un posterior HTTP 500 del POST en rechazo seguro ni lo repite", async () => {
  const api = provider((_url, options) => options.method === "GET" ? Response.json(balance())
    : Response.json({ type: "Exception", title: "Ocurrió un error", status: 500,
      detail: "No posees saldo suficiente para realizar la operación." }, { status: 500 }));
  const prepared = await preparer(api).prepare();
  await assert.rejects(prepared.sendOnce(), error => {
    assert.equal(error.name, "FirmaSeguroApiError");
    assert.equal(error.status, 500);
    assert.equal(error.code, undefined);
    return true;
  });
  await assert.rejects(prepared.sendOnce(), /REISSUE_ALREADY_DISPATCHED/);
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests.filter(request => request.method === "POST").length, 1);
});
