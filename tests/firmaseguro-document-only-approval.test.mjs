import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const factory = await jiti.import("../lib/credit-factory.ts");
const amortization = await jiti.import("../lib/credit-amortization.ts");
const phones = await jiti.import("../lib/credit-contact-phones.ts");
const veriff = await jiti.import("../lib/veriff.ts");
const { FirmaSeguroFullNameIdentityError } = await jiti.import("../lib/datacredito/firmaseguro-identity.ts");
const { compareStrictIdentityDocuments } = await jiti.import("../lib/veriff-identity.ts");
const fullName = "María del Mar  De la Peña Muñoz";
const documentNumber = "123456789";
const identity = { nameMode: "FULL_NAME_ONLY", names: "", firstSurname: "", secondSurname: "", fullName,
  documentType: "CEDULA_DE_CIUDADANIA", documentNumber, missing: [] };
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const builderSource = readFileSync(new URL("../lib/firmaseguro-draft-credit-builder.ts", import.meta.url), "utf8").replace(/^import\b[^;]*;\r?\n/gm, "");
function declarations(file, names) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, name);return declaration.getText(ast).replace(/^export /, "");
  }).join("\n");
}
function fixture({ bridgeAvailable = false } = {}) {
  let bridgeCalls = 0;
  const module = { exports: {} };
  runInNewContext(compile(builderSource), {
    module, exports: module.exports, Error, process, ...factory, ...amortization, ...phones,
    FirmaSeguroFullNameIdentityError,
    enforceDataCreditoCustomerIdentity: async payload => {
      assert.equal(payload.clienteDocumento, documentNumber);
      payload.clienteNombre = fullName;payload.clientePrimerNombre = "";payload.clientePrimerApellido = "";payload.clienteSegundoApellido = "";
      return { original: identity, effective: identity, querySurname: "APELLIDO DIGITADO" };
    },
    getFirmaSeguroFullNameIdentityForDraft: async input => {
      bridgeCalls++;assert.equal(input.fullName, fullName);assert.equal(input.documentNumber, documentNumber);
      if (!bridgeAvailable) throw new FirmaSeguroFullNameIdentityError();
      return { source: "VERIFF", validationId: 42, canonicalFullName: fullName, documentNumber,
        firstName: "María del Mar", firstLastName: "De la Peña Muñoz", secondName: null, secondLastName: null };
    },
    getDataCreditoPublicConfig: () => ({ enabled: false }),
    getEffectiveCreditSettings: async () => ({ globalSettings: {
      cuotaInicialPorcentaje: 20, iphoneTopeFinanciado: 3500000, iphoneTopeCuota: 160000,
      plazoCuotas: 12, plazoMaximoCuotas: 48,
    } }),
    findEquipmentCatalogItem: async () => null,
    findEquipmentCatalogItemById: async () => null,
    resolveCreditPolicyFinancialSettings: () => ({ calculoVersion: "ARES_FRANCES_V2", tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 }, tasaInteresEa: 20,
      fianzaCuotaPorcentaje: 0, fianzaTotalPorcentaje: 0, fianzaModalidad: "TOTAL_CREDITO",
      fianzaSource: "GLOBAL", seguroCuotaPorcentaje: 0, frecuenciaPago: "MENSUAL" }),
    hasCurrentCreditOriginationTerms: () => true,
    validateIphoneInstallmentLimit: () => ({ outsideRange: false }),
  });
  const row = { id: 530, estado: "ABIERTO", usuarioId: 23, vendedorId: 45, sedeId: 1, sedeAliadoId: null,
    clienteDocumento: documentNumber, currentStep: 4,
    payload: { clienteNombre: fullName, clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "",
      clienteDocumento: documentNumber, clienteTipoDocumento: identity.documentType,
      clienteTelefono: "3001234567", clienteCorreo: "cliente@example.com", clienteDireccion: "Calle 1 # 2-3",
      referenciaFamiliar1Telefono: "3101234567", referenciaFamiliar2Telefono: "3201234567",
      equipoMarca: "Apple", equipoModelo: "iPhone 15", plataformaDispositivo: "IPHONE", imei: "123456789012345",
      valorEquipoTotal: "1200000", cuotaInicial: "240000", plazoMeses: "12", veriffValidationId: 42 } };
  return { ...module.exports, row, bridgeCalls: () => bridgeCalls };
}

test("preparar contrato con nombre DataCrédito completo no exige nombres separados de Veriff", async () => {
  const f = fixture();
  const built = await f.buildDraftCredit(f.row);
  assert.equal(built.credit.clienteNombre, fullName);assert.equal(built.credit.clientePrimerNombre, "");assert.equal(built.credit.clientePrimerApellido, "");
  assert.equal(built.credit.contratoSnapshot.dataCreditoIdentity.effective.fullName, fullName);
  assert.equal(Object.hasOwn(built.credit.contratoSnapshot, "firmaSeguroIdentity"), false);assert.equal(f.bridgeCalls(), 0);
});

test("despacho real FirmaSeguro sigue exigiendo componentes verificables sin inventarlos", async () => {
  const f = fixture();
  await assert.rejects(f.buildDraftCredit(f.row, { requireFirmaSeguroIdentity: true }), error => error.code === "FIRMASEGURO_IDENTITY_COMPONENTS_REQUIRED" && error.status === 409);
  assert.equal(f.bridgeCalls(), 1);
  const complete = fixture({ bridgeAvailable: true });
  const built = await complete.buildDraftCredit(complete.row, { requireFirmaSeguroIdentity: true });
  assert.equal(built.credit.clienteNombre, fullName);assert.equal(built.credit.contratoSnapshot.firmaSeguroIdentity.source, "VERIFF");
  assert.equal(complete.bridgeCalls(), 1);
});

test("la guarda de FirmaSeguro acepta aprobación confiable de la misma CC sin nombres ni apellidos Veriff", async () => {
  let trusted = true;
  const validation = { id: 42, draftId: 530, creditoId: null, status: "APPROVED", decision: "APPROVED",
    clienteDocumento: documentNumber, decidedAt: new Date(), decisionPayload: { verification: {
      status: "approved", person: { idNumber: documentNumber }, document: { type: "ID_CARD", country: "CO", number: documentNumber },
    } } };
  const row = { id: 530, clienteDocumento: documentNumber, payload: { veriffValidationId: 42, clienteDocumento: documentNumber } };
  const code = declarations("../lib/veriff-storage.ts", ["objectValue", "statusFromDecisionPayload", "resolveVeriffRowStatus", "isVeriffApproved"])
    + "\n" + declarations("../app/api/creditos/borradores/[id]/firma-seguro/route.ts", ["payloadObject", "requireApprovedVeriffBeforeFirmaSeguro"])
    + "\nmodule.exports = requireApprovedVeriffBeforeFirmaSeguro;";
  const module = { exports: {} };const { CreditValidationError } = fixture();
  runInNewContext(compile(code), { module, exports: module.exports, Error, ...factory, ...veriff,
    areVeriffDecisionsTrusted: () => trusted, compareStrictIdentityDocuments, CreditValidationError,
    getDataCreditoPublicConfig: () => ({ enabled: true }),
    getVeriffValidationById: async () => validation,
    prisma: { $queryRawUnsafe: async () => [{ id: 42 }] },
  });
  await module.exports(row);
  trusted = false;await assert.rejects(module.exports(row));trusted = true;
  validation.draftId = 531;await assert.rejects(module.exports(row));validation.draftId = 530;
  validation.clienteDocumento = "987654321";await assert.rejects(module.exports(row));validation.clienteDocumento = documentNumber;
  validation.status = "DECLINED";validation.decision = "DECLINED";validation.decisionPayload.verification.status = "declined";
  await assert.rejects(module.exports(row));
});
