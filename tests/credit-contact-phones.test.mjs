import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  CREDIT_CONTACT_PHONE_LENGTH,
  isValidCreditContactPhone,
  normalizeCreditContactPhoneInput,
  validateCreditContactPhones,
} = await jiti.import("../lib/credit-contact-phones.ts");

const validPhones = {
  clienteTelefono: "3001234567",
  referenciaFamiliar1Telefono: "3102345678",
  referenciaFamiliar2Telefono: "3203456789",
};

test("acepta tres teléfonos distintos de exactamente 10 dígitos", () => {
  const result = validateCreditContactPhones(validPhones);

  assert.equal(CREDIT_CONTACT_PHONE_LENGTH, 10);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, validPhones);
});

test("normaliza la escritura del formulario y no permite más de 10 dígitos", () => {
  assert.equal(normalizeCreditContactPhoneInput("300 123-4567"), "3001234567");
  assert.equal(normalizeCreditContactPhoneInput("+57 3001234567"), "3001234567");
  assert.equal(normalizeCreditContactPhoneInput("0057 3001234567"), "3001234567");
  assert.equal(normalizeCreditContactPhoneInput("300123456789"), "");
  assert.equal(isValidCreditContactPhone("3001234567"), true);
});

test("rechaza longitudes y formatos inválidos en cualquiera de los tres campos", () => {
  const cases = [
    ["clienteTelefono", "300123456"],
    ["clienteTelefono", "30012345678"],
    ["clienteTelefono", "+573001234567"],
    ["referenciaFamiliar1Telefono", "310234567"],
    ["referenciaFamiliar1Telefono", "310 234 5678"],
    ["referenciaFamiliar2Telefono", "32034567890"],
    ["referenciaFamiliar2Telefono", "32034A6789"],
  ];

  for (const [field, value] of cases) {
    const result = validateCreditContactPhones({ ...validPhones, [field]: value });
    assert.equal(result.ok, false, field + "=" + value + " debía ser inválido");
    assert.match(result.message, /10 dígitos/);
  }
});

test("rechaza cada combinación posible de teléfonos repetidos", () => {
  const duplicateCases = [
    {
      ...validPhones,
      referenciaFamiliar1Telefono: validPhones.clienteTelefono,
    },
    {
      ...validPhones,
      referenciaFamiliar2Telefono: validPhones.clienteTelefono,
    },
    {
      ...validPhones,
      referenciaFamiliar2Telefono: validPhones.referenciaFamiliar1Telefono,
    },
  ];

  for (const phones of duplicateCases) {
    const result = validateCreditContactPhones(phones);
    assert.equal(result.ok, false);
    assert.equal(result.code, "CONTACT_PHONE_DUPLICATE");
    assert.match(result.message, /No se pueden repetir/);
  }
});

test("el formulario, la creación final y FirmaSeguro comparten la misma regla", () => {
  const clientSource = readFileSync(
    new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
    "utf8"
  );
  const createRouteSource = readFileSync(
    new URL("../app/api/creditos/route.ts", import.meta.url),
    "utf8"
  );
  const firmaSeguroSource = readFileSync(
    new URL(
      "../app/api/creditos/borradores/[id]/firma-seguro/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  const stepClienteReadyBlock = clientSource.slice(
    clientSource.indexOf("const stepClienteReady"),
    clientSource.indexOf("const otpReady")
  );
  const pasteHandlerBlock = clientSource.slice(
    clientSource.indexOf("const pasteCreditContactPhone"),
    clientSource.indexOf("const stepClienteReady")
  );
  const otpBlock = clientSource.slice(
    clientSource.indexOf("const createWhatsAppOtp"),
    clientSource.indexOf("const verifyOtp")
  );
  const createRoutePhoneBlock = createRouteSource.slice(
    createRouteSource.indexOf("const contactPhoneValidation"),
    createRouteSource.indexOf("if (clienteFechaNacimiento")
  );
  const firmaSeguroPhoneBlock = firmaSeguroSource.slice(
    firmaSeguroSource.indexOf("const contactPhoneValidation"),
    firmaSeguroSource.indexOf("const contratoFotoDataUrl")
  );

  assert.match(stepClienteReadyBlock, /contactPhoneValidation\.ok/);
  assert.match(pasteHandlerBlock, /event\.preventDefault\(\)/);
  assert.match(pasteHandlerBlock, /event\.clipboardData\.getData\("text"\)/);
  assert.equal(
    (clientSource.match(/pasteCreditContactPhone\(\s*event,/g) || []).length,
    3
  );
  assert.match(otpBlock, /if \(!clienteTelefonoValido\)/);
  assert.doesNotMatch(otpBlock, /contactPhoneValidation/);
  assert.match(
    clientSource,
    /disabled=\{\s*creating \|\|\s*veriffSubmitting \|\|\s*!stepClienteReady/
  );
  assert.match(clientSource, /normalizeCreditContactPhoneInput/);
  assert.ok(
    (clientSource.match(/maxLength=\{CREDIT_CONTACT_PHONE_LENGTH\}/g) || []).length >= 3
  );
  assert.ok((clientSource.match(/inputMode="numeric"/g) || []).length >= 3);
  assert.match(createRoutePhoneBlock, /validateCreditContactPhones\(\{/);
  assert.match(createRoutePhoneBlock, /code: contactPhoneValidation\.code/);
  assert.match(createRoutePhoneBlock, /\{ status: 400 \}/);
  assert.match(firmaSeguroPhoneBlock, /validateCreditContactPhones\(\{/);
  assert.match(
    firmaSeguroPhoneBlock,
    /throw new CreditValidationError\(contactPhoneValidation\.message\)/
  );
});
