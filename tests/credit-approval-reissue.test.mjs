import assert from "node:assert/strict";
import test from "node:test";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";
const source = loadReissueModule("lib/credit-approval-reissue-source.ts", {"@/lib/credit-amortization-contract": seals});

test("reemisión usa el sello congelado con folio, cantidades y fecha del proceso original", () => {
  const fixture = createReissueFixture();
  const result = source.frozenReissueCredit(fixture.credit, fixture.process);
  assert.equal(result.credit.folio, fixture.credit.folio);
  assert.equal(result.credit.montoCredito, 920000);
  assert.equal(result.credit.valorCuota, 230000);
  assert.equal(result.credit.fechaCredito, "2099-01-01T12:00:00.000Z");
  assert.equal(result.termsHash, fixture.seal.checksum);
  assert.equal(fixture.credit.contratoSnapshot.firmaSeguro.uuid, "old-process-81");
});
test("rechaza sellos ausentes, alterados y discrepancias contractuales sin recalcular", () => {
  const changes = [
    f => { delete f.process.draftPayload.financialTermsSeal; },
    f => { f.credit.contratoSnapshot.financiero.selloFinanciero.checksum = "a".repeat(64); },
    f => { f.credit.montoCredito += 1000; },
    f => { f.credit.contratoSnapshot.financiero.cuotaComercial += 1000; },
    f => { f.credit.clienteTelefono = "3000000002"; },
    f => { f.credit.imei = "999999999999999"; },
    f => { f.process.draftFolio = "OTRO-FOLIO"; },
  ];
  for (const change of changes) {
    const f = createReissueFixture();
    change(f);
    assert.throws(() => source.frozenReissueCredit(f.credit,f.process), /FROZEN_TERMS_/);
  }
});
test("un POST de reemisión con HTTP 401 no repite el envío con otra cabecera", async () => {
  const calls = [];
  const provider = loadReissueModule("lib/firmaseguro.ts", {}, {
    process: {env:{FIRMASEGURO_BASE_URL:"https://provider.invalid"}},
    fetch: async (url, options) => {
      calls.push({url,options});
      return Response.json({error:"Unauthorized"},{status:401});
    },
  });
  await assert.rejects(provider.firmaSeguroCreateFull("test-token",{folio:"TEST"},{retryAuthorization:false}));
  assert.equal(calls.length,1);
  await assert.rejects(provider.firmaSeguroCreateFullByCompany("test-token",{folio:"TEST"},{retryAuthorization:false}));
  assert.equal(calls.length,2);
  await assert.rejects(provider.firmaSeguroCreateFull("test-token",{folio:"LEGACY"}));
  assert.equal(calls.length,4,"Other flows retain their existing authorization fallback");
});
test("estado seguro no expone PDF, datos contractuales ni cargas del proveedor", async () => {
  const state = loadReissueModule("lib/credit-approval-reissue-state.ts");
  const item = await state.getCreditApprovalReissueState({$queryRawUnsafe: async () => [{
    id:"test",status:"UNCERTAIN",reason:"Firma ilegible",requestedAt:new Date(),lastCheckedAt:null,
    completedAt:null,newProcessUuid:null,documentBase64:"secret",requestPayload:{password:"secret"},
  }]},81);
  assert.equal(item.blocked,true);
  assert.equal(item.available,false);
  assert.equal(item.operation.canRefresh,false);
  assert.doesNotMatch(JSON.stringify(item), /secret|documentBase64|requestPayload/);
});
