import assert from "node:assert/strict";
import test from "node:test";
import { resolveCreditAssignedAdministrator, resolveCreditSellerDisplay } from "../lib/credit-assigned-seller.ts";

const imported = () => ({
  usuario: { id: 1, nombre: "Creador original", usuario: "original" },
  vendedor: null,
  vendedorId: null,
  sedeId: 67,
  contratoAceptadoAt: null,
  pagareAceptadoAt: null,
  contratoFirmaDataUrl: null,
  contratoSnapshot: {
    origen: { tipo: "IMPORTACION_MASIVA", sinFirmaDigital: true },
    asignacion: {
      sedeId: 67, vendedorId: null, vendedor: "Responsable de sede",
      responsableUsuarioId: 28, tipoResponsable: "ADMINISTRADOR",
    },
    financiero: { valorCuota: 99800 },
  },
});

test("muestra al administrador asignado sin alterar creador ni vendedor", () => {
  const credit = imported();
  const before = structuredClone(credit);
  assert.deepEqual(resolveCreditAssignedAdministrator(credit), { id: 28, nombre: "Responsable de sede" });
  assert.deepEqual(resolveCreditSellerDisplay(credit), { id: 28, nombre: "Responsable de sede", usuario: "" });
  assert.deepEqual(credit, before);
});

test("conserva vendedor y usuario de presentación en créditos ordinarios", () => {
  const credit = { usuario: { id: 1, nombre: "Usuario", usuario: "login" },
    vendedor: { id: 9, nombre: "Vendedor", documento: "123" } };
  assert.deepEqual(resolveCreditSellerDisplay(credit), { id: 9, nombre: "Vendedor", usuario: "123" });
  assert.deepEqual(resolveCreditSellerDisplay({ usuario: credit.usuario }), credit.usuario);
  assert.deepEqual(resolveCreditSellerDisplay({}, "Sin responsable"), { id: 0, nombre: "Sin responsable", usuario: "" });
});

test("ignora asignaciones históricas sin evidencia de importación no firmada", () => {
  for (const patch of [
    { contratoAceptadoAt: new Date() }, { pagareAceptadoAt: new Date() },
    { contratoFirmaDataUrl: "firma" }, { sedeId: 64 }, { vendedorId: 9 },
    { vendedor: { id: 9, nombre: "Vendedor actual", documento: "123" } },
  ]) assert.equal(resolveCreditAssignedAdministrator({ ...imported(), ...patch }), null);
  for (const patch of [{ tipo: "VENTA" }, { sinFirmaDigital: false }, { sinFirmaDigital: undefined }]) {
    const credit = imported();
    Object.assign(credit.contratoSnapshot.origen, patch);
    assert.equal(resolveCreditAssignedAdministrator(credit), null);
    assert.deepEqual(resolveCreditSellerDisplay(credit), credit.usuario);
  }
  const sealed = imported();
  sealed.contratoSnapshot.financiero.selloFinanciero = { snapshot: { monto: 10 } };
  assert.equal(resolveCreditAssignedAdministrator(sealed), null);
});

test("rechaza IDs, nombres, roles y sede inconsistentes del responsable", () => {
  for (const patch of [
    { responsableUsuarioId: 0 }, { responsableUsuarioId: "28" }, { responsableUsuarioId: 1.5 },
    { vendedor: " " }, { tipoResponsable: "VENDEDOR" }, { vendedorId: 28 }, { sedeId: 64 },
  ]) {
    const credit = imported();
    Object.assign(credit.contratoSnapshot.asignacion, patch);
    assert.equal(resolveCreditAssignedAdministrator(credit), null);
  }
});
