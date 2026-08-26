import assert from "node:assert/strict";
import test from "node:test";
import { validateCreditClientForm } from "../lib/credit-client-validation.ts";

const completeClient = {
  clientePrimerNombre: "Marcos",
  clientePrimerApellido: "Patino",
  clienteTipoDocumento: "CC",
  clienteDocumento: "1110178524",
  clienteFechaExpedicion: "2014-05-26",
  clienteFechaNacimiento: "1995-11-23",
  clienteTelefono: "3144201136",
  clienteCorreo: "cliente@finserpay.com",
  clienteDepartamento: "TOLIMA",
  clienteCiudad: "IBAGUE",
  clienteGenero: "MASCULINO",
  clienteEstadoCivil: "SOLTERO",
  clienteEstrato: "1",
  clienteDireccion: "Carrera 6 # 70-70",
  referenciaFamiliar1Nombre: "Ana Patino",
  referenciaFamiliar1Parentesco: "Madre",
  referenciaFamiliar1Telefono: "3101234567",
  referenciaFamiliar2Nombre: "Luis Gomez",
  referenciaFamiliar2Parentesco: "Padre",
  referenciaFamiliar2Telefono: "3111234567",
};

test("habilita los tres bloques solo con datos completos y validos", () => {
  const result = validateCreditClientForm(
    completeClient,
    new Date("2026-08-25T12:00:00.000Z")
  );

  assert.equal(result.personalComplete, true);
  assert.equal(result.contactComplete, true);
  assert.equal(result.referencesComplete, true);
  assert.equal(result.completedBlocks, 3);
  assert.equal(result.firstInvalidField, null);
});

test("bloquea contacto y referencias cuando datos personales quedan incompletos", () => {
  const result = validateCreditClientForm(
    { ...completeClient, clienteDocumento: "   " },
    new Date("2026-08-25T12:00:00.000Z")
  );

  assert.equal(result.personalComplete, false);
  assert.equal(result.contactComplete, false);
  assert.equal(result.referencesComplete, false);
  assert.equal(result.firstInvalidField, "clienteDocumento");
});

test("exige estado civil, estrato y las dos referencias", () => {
  const result = validateCreditClientForm(
    {
      ...completeClient,
      clienteEstadoCivil: "",
      clienteEstrato: "",
      referenciaFamiliar2Telefono: "",
    },
    new Date("2026-08-25T12:00:00.000Z")
  );

  assert.equal(result.personalComplete, true);
  assert.equal(result.contactComplete, false);
  assert.equal(result.referencesComplete, false);
  assert.match(result.errors.clienteEstadoCivil, /obligatorio/i);
  assert.match(result.errors.clienteEstrato, /obligatorio/i);
  assert.match(result.errors.referenciaFamiliar2Telefono, /obligatorio/i);
});

test("rechaza formatos invalidos y fechas incoherentes", () => {
  const result = validateCreditClientForm(
    {
      ...completeClient,
      clienteTelefono: "123",
      clienteCorreo: "correo-invalido",
      clienteFechaNacimiento: "2027-01-01",
      clienteFechaExpedicion: "1990-01-01",
    },
    new Date("2026-08-25T12:00:00.000Z")
  );

  assert.match(result.errors.clienteTelefono, /10 numeros/i);
  assert.match(result.errors.clienteCorreo, /valido/i);
  assert.match(result.errors.clienteFechaNacimiento, /futuro/i);
  assert.match(result.errors.clienteFechaExpedicion, /nacimiento/i);
  assert.equal(result.complete, false);
});

test("exige telefonos de 10 digitos en las referencias", () => {
  const result = validateCreditClientForm(
    {
      ...completeClient,
      referenciaFamiliar1Telefono: "1234567",
    },
    new Date("2026-08-25T12:00:00.000Z")
  );

  assert.match(result.errors.referenciaFamiliar1Telefono, /10 numeros/i);
  assert.equal(result.referencesComplete, false);
  assert.equal(result.complete, false);
});

test("rechaza telefonos repetidos entre cliente y referencias", () => {
  const result = validateCreditClientForm(
    {
      ...completeClient,
      referenciaFamiliar1Telefono: completeClient.clienteTelefono,
      referenciaFamiliar2Telefono: completeClient.clienteTelefono,
    },
    new Date("2026-08-25T12:00:00.000Z")
  );

  assert.match(result.errors.clienteTelefono, /diferente/i);
  assert.match(result.errors.referenciaFamiliar1Telefono, /diferente/i);
  assert.match(result.errors.referenciaFamiliar2Telefono, /diferente/i);
  assert.equal(result.contactComplete, false);
  assert.equal(result.referencesComplete, false);
  assert.equal(result.complete, false);
});
