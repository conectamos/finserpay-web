import assert from "node:assert/strict";
import test from "node:test";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";
const contractImei = loadReissueModule("lib/credit-contract-imei.ts");
const approvalErrors = loadReissueModule("lib/credit-approval-errors.ts");
const dataCore = loadReissueModule("lib/credit-approval-data-core.ts", {
  "@/lib/credit-approval-errors": approvalErrors,
});
const source = loadReissueModule("lib/credit-approval-reissue-source.ts", {
  "@/lib/credit-amortization-contract": seals,
  "@/lib/credit-contract-imei": contractImei,
  "@/lib/credit-approval-data-core": dataCore,
});

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

test("reemisión conserva nombres Veriff del proceso firmado y la identidad DC sellada por separado", () => {
  const fixture = createReissueFixture();
  const metadata = { source: "VERIFF", validationId: 42, documentNumber: fixture.seal.snapshot.documento,
    canonicalFullName: fixture.seal.snapshot.clienteNombre, firstName: "Nombre real Veriff",
    firstLastName: "Apellido original", secondName: null, secondLastName: null };
  fixture.process.draftPayload = { ...fixture.process.draftPayload,
    firmaSeguroContractNameVersion: 1, firmaSeguroIdentity: metadata };
  fixture.credit.contratoSnapshot.firmaSeguroIdentity = { ...metadata, firstName: "Nombre operativo distinto" };
  const before = JSON.stringify(fixture);
  const result = source.frozenReissueCredit(fixture.credit, fixture.process);
  assert.equal(result.credit.contratoSnapshot.firmaSeguroContractNameVersion, 1);
  assert.deepEqual(result.credit.contratoSnapshot.firmaSeguroIdentity, metadata);
  assert.equal(result.credit.clienteNombre, fixture.seal.snapshot.clienteNombre);
  assert.equal(result.credit.clienteDocumento, fixture.seal.snapshot.documento);
  assert.equal(result.credit.valorCuota, fixture.credit.valorCuota);
  assert.equal(result.termsHash, fixture.seal.checksum);
  assert.equal(JSON.stringify(fixture), before, "no modifica el proceso ni el crédito históricos");
});

test("reemisión legacy sin marcador de proceso no cambia la identidad contractual por metadata operativa", () => {
  const fixture = createReissueFixture();
  fixture.credit.contratoSnapshot.firmaSeguroContractNameVersion = 1;
  fixture.credit.contratoSnapshot.firmaSeguroIdentity = { firstName: "Nombre operativo" };
  const result = source.frozenReissueCredit(fixture.credit, fixture.process);
  assert.equal(Object.hasOwn(result.credit, "contratoSnapshot"), false);
  assert.equal(result.credit.clienteNombre, fixture.seal.snapshot.clienteNombre);
});
test("rechaza sellos ausentes, alterados y discrepancias contractuales sin recalcular", () => {
  const changes = [
    f => { delete f.process.draftPayload.financialTermsSeal; },
    f => { f.credit.contratoSnapshot.financiero.selloFinanciero.checksum = "a".repeat(64); },
    f => { f.credit.montoCredito += 1000; },
    f => { f.credit.contratoSnapshot.financiero.cuotaComercial += 1000; },
    f => { f.credit.clienteTelefono = "3000000002"; },
    f => { f.process.draftFolio = "OTRO-FOLIO"; },
  ];
  for (const change of changes) {
    const f = createReissueFixture();
    change(f);
    assert.throws(() => source.frozenReissueCredit(f.credit,f.process), /FROZEN_TERMS_/);
  }
});
test("un IMEI operativo reemplazado no altera la reemisión del contrato original", () => {
  const fixture = createReissueFixture();
  fixture.credit.imei = "999999999999999";
  fixture.credit.deviceUid = "999999999999999";
  const result = source.frozenReissueCredit(fixture.credit, fixture.process);
  assert.equal(result.credit.imei, "123456789012345");
  assert.equal(result.credit.deviceUid, "123456789012345");
});
test("una referencia operativa histórica no exige ledger y la reemisión conserva la referencia contractual", () => {
  const fixture = createReissueFixture();
  fixture.credit.referenciaEquipo = "SAMSUNG REFERENCIA OPERATIVA CORREGIDA";
  const result = source.frozenReissueCredit(fixture.credit, fixture.process);
  assert.equal(result.credit.referenciaEquipo, "SAMSUNG TEST");
});
test("correo, teléfono y dirección corregidos requieren una cadena auditada íntegra", () => {
  const fixture = createReissueFixture();
  const before = {
    clienteCorreo: fixture.credit.clienteCorreo,
    clienteTelefono: fixture.credit.clienteTelefono,
    clienteDepartamento: null,
    clienteCiudad: null,
    clienteDireccion: fixture.credit.clienteDireccion,
    referenciaEquipo: null,
  };
  const after = {
    ...before,
    clienteCorreo: "corregido@example.invalid",
    clienteTelefono: "3000000099",
    clienteDireccion: "CALLE CORREGIDA 99",
  };
  Object.assign(fixture.credit, after);
  const result = source.frozenReissueCredit(fixture.credit, fixture.process, [{
    before, after, requestedRevision: 1, resultingRevision: 2,
  }]);
  assert.equal(result.credit.clienteCorreo, "cliente@example.invalid");
  assert.equal(result.credit.clienteTelefono, "3000000001");
  assert.equal(result.credit.clienteDireccion, "CALLE DE PRUEBA 1");
  assert.throws(() => source.frozenReissueCredit(fixture.credit, fixture.process, [{
    before: { ...before, clienteTelefono: "otro" }, after, requestedRevision: 1, resultingRevision: 2,
  }]), /FROZEN_TERMS_/);
});
test("un nombre operativo corregido permite reemisión solo con la cadena auditada nueva", () => {
  const fixture = createReissueFixture();
  const before = {
    clienteNombre: fixture.credit.clienteNombre,
    clienteCorreo: fixture.credit.clienteCorreo,
    clienteTelefono: fixture.credit.clienteTelefono,
    clienteDepartamento: null,
    clienteCiudad: null,
    clienteDireccion: fixture.credit.clienteDireccion,
    referenciaEquipo: null,
  };
  const after = { ...before, clienteNombre: "CLIENTE CON NOMBRE CORREGIDO" };
  fixture.credit.clienteNombre = after.clienteNombre;

  assert.throws(
    () => source.frozenReissueCredit(fixture.credit, fixture.process),
    /FROZEN_TERMS_CHANGED/
  );

  const result = source.frozenReissueCredit(fixture.credit, fixture.process, [{
    before,
    after,
    requestedRevision: 1,
    resultingRevision: 2,
  }]);
  assert.equal(result.credit.clienteNombre, fixture.seal.snapshot.clienteNombre);
  assert.equal(result.credit.clienteDocumento, fixture.seal.snapshot.documento);
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
