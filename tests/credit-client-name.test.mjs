import assert from "node:assert/strict";
import test from "node:test";
import {
  composeCreditClientName,
  hasAuditedCreditIdentityCorrection,
  splitStoredCreditClientName,
} from "../lib/credit-client-name.ts";

test("el nombre legal conserva ambos nombres y apellidos sin alterar el primero", () => {
  const identity = {
    firstNames: "  ANA   MARÍA ",
    firstSurname: " GÓMEZ ",
    secondSurname: "  RUIZ  ",
  };

  assert.equal(
    composeCreditClientName(identity),
    "ANA MARÍA GÓMEZ RUIZ"
  );
  assert.equal(identity.firstSurname, " GÓMEZ ");
});

test("los borradores sin segundo apellido conservan el nombre anterior", () => {
  assert.equal(
    composeCreditClientName({
      firstNames: "ANA MARÍA",
      firstSurname: "GÓMEZ",
    }),
    "ANA MARÍA GÓMEZ"
  );
});

test("la precarga de un crédito conserva los dos nombres y el segundo apellido", () => {
  assert.deepEqual(
    splitStoredCreditClientName({
      fullName: "ANA MARÍA GÓMEZ RUIZ",
      firstSurname: "GÓMEZ",
    }),
    {
      firstNames: "ANA MARÍA",
      firstSurname: "GÓMEZ",
      secondSurname: "RUIZ",
    },
  );
  assert.equal(
    splitStoredCreditClientName({
      fullName: "NOMBRE QUE NO COINCIDE",
      firstSurname: "GÓMEZ",
    }),
    null,
  );
});

test("una corrección auditada impide que Veriff reemplace el nombre al retomar", () => {
  assert.equal(hasAuditedCreditIdentityCorrection({}), false);
  assert.equal(
    hasAuditedCreditIdentityCorrection({ firmaSeguroIdentityCorrectionPending: true }),
    true,
  );
  assert.equal(
    hasAuditedCreditIdentityCorrection({
      firmaSeguroIdentityReissueProcessUuid: "proceso-nuevo",
    }),
    true,
  );
});
