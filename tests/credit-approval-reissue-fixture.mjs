import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
export function loadReissueModule(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    module: loadedModule, exports: loadedModule.exports, Buffer, Uint8Array, Date, console, URL, Request, Response, TextDecoder,
    process: {env: {}}, ...globals,
    require: name => {
      if (name === "server-only") return {};
      if (name === "node:crypto") return crypto;
      assert.ok(name in dependencies, "Unexpected dependency " + name + " in " + path);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}
export const seals = loadReissueModule("lib/credit-amortization-contract.ts");
export function createReissueFixture(id = 81) {
  const seal = seals.createFinancingTermsSeal({
    folio: "FNS-REISSUE-" + id, documento: "100000001",
    contrato: { tipoDocumento: "CEDULA_DE_CIUDADANIA", clienteNombre: "CLIENTE PRUEBA",
      clienteTelefono: "3000000001", clienteCorreo: "cliente@example.invalid", clienteDireccion: "CALLE DE PRUEBA 1",
      equipoMarca: "SAMSUNG", equipoModelo: "TEST", referenciaEquipo: "SAMSUNG TEST", imei: "123456789012345" },
    amortizacion: {
      version: "TEST_V1", valorVenta: 1000000, cuotaInicial: 200000, valorFinanciado: 800000, numeroCuotas: 4,
      frecuenciaPago: "MENSUAL", cuotas: [{ fechaVencimiento: "2099-02-01" }], tasaInteresEa: 24, tasaPeriodo: 0.018,
      fianzaCuotaPorcentaje: 2.5, seguroCuotaPorcentaje: 0, cuotaCredito: 210000, cuotaFianza: 20000,
      cuotaSeguro: 0, cuotaTotal: 230000, cuotaComercial: 230000, montoTotal: 920000,
    },
    parametros: { fianzaTotalPorcentaje: 10, fianzaModalidad: "TOTAL_CREDITO", fianzaFuente: "TEST",
      tasaPeriodoDecimales: 12, redondeoComercial: {modo: "REDONDEO",multiplo: 1000} },
  });
  const credit = {
    id, folio: seal.snapshot.folio, clienteNombre: seal.snapshot.clienteNombre, clienteDocumento: "100000001",
    clienteTelefono: "3000000001", clienteCorreo: "cliente@example.invalid", clienteDireccion: "CALLE DE PRUEBA 1",
    equipoMarca: "SAMSUNG",equipoModelo: "TEST",imei: "123456789012345",frecuenciaPago: "MENSUAL",
    valorEquipoTotal: 1000000,cuotaInicial: 200000,saldoBaseFinanciado: 800000,montoCredito: 920000,
    valorCuota: 230000,plazoMeses: 4,tasaInteresEa: 24,
    eligible: true,paid: false,createdAt: "2099-01-01T12:00:00Z",estado: "INSCRITO",sedeId: 10,
    contratoSnapshot: { cliente: { nombre: seal.snapshot.clienteNombre, cedula: "100000001" },
      equipo: { plataforma: "ANDROID",imei: "123456789012345" },
      financiero: { selloFinanciero: seal, cuotaInicial: 200000, saldoBaseFinanciado: 800000,
        cuotaComercial: 230000,cuotaTotalExacta: 230000,fianzaCuotaPorcentaje: 2.5,seguroCuotaPorcentaje: 0 },
      firmaSeguro: {uuid: "old-process-" + id, estado: "COMPLETED"} },
  };
  const signedPdf = Buffer.from("%PDF-1.4\nOriginal signed test " + id + "\n%%EOF").toString("base64");
  const process = {
    id: id+100,creditoId:id,draftId:id+200,draftFolio:credit.folio,processUuid:"old-process-"+id,
    draftPayload:{financialTermsSeal:seal},status:"COMPLETED",signedDocumentBase64:signedPdf,
    signedDocumentFileName:credit.folio+".pdf",createdAt:new Date("2099-01-01T12:00:00Z"),
    completedAt:new Date("2099-01-01T12:10:00Z"),supersededAt:null,
  };
  return { credit, process, seal, signedPdf };
}
