import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  findCreditCreatedAfterConnectionLoss,
  isCreditCreationNetworkError,
} = await jiti.import("../lib/credit-create-recovery.ts");

test("recupera un credito reciente con documento e IMEI exactos", () => {
  const requestedAt = Date.now();
  const credit = {
    id: 91,
    clienteDocumento: "1.110.508.726",
    imei: "355190874496946",
    createdAt: new Date(requestedAt + 500).toISOString(),
    estado: "ENTREGABLE",
  };

  assert.equal(
    findCreditCreatedAfterConnectionLoss([credit], {
      documentNumber: "1110508726",
      imei: "355190874496946",
      requestedAt,
    }),
    credit
  );
});

test("no confunde un credito anterior ni otro IMEI", () => {
  const requestedAt = Date.now();
  const items = [
    {
      clienteDocumento: "1110508726",
      imei: "355190874496946",
      createdAt: new Date(requestedAt - 300_000).toISOString(),
      estado: "ENTREGABLE",
    },
    {
      clienteDocumento: "1110508726",
      imei: "350792390007233",
      createdAt: new Date(requestedAt + 500).toISOString(),
      estado: "ENTREGABLE",
    },
  ];

  assert.equal(
    findCreditCreatedAfterConnectionLoss(items, {
      documentNumber: "1110508726",
      imei: "355190874496946",
      requestedAt,
    }),
    null
  );
});

test("reconoce errores de red sin ocultar errores funcionales", () => {
  assert.equal(
    isCreditCreationNetworkError(new TypeError("Failed to fetch")),
    true
  );
  assert.equal(isCreditCreationNetworkError(new Error("Load failed")), true);
  assert.equal(
    isCreditCreationNetworkError(new Error("The network connection was lost")),
    true
  );
  assert.equal(
    isCreditCreationNetworkError(new Error("La cedula ya tiene un credito activo")),
    false
  );
});

test("el servidor recupera cualquier credito que ya alcanzo el commit", async () => {
  const source = await readFile("app/api/creditos/route.ts", "utf8");
  assert.match(source, /if \(createdCreditId\) \{/);
  assert.doesNotMatch(
    source,
    /dataCreditoAssessmentConsumed && createdCreditId/
  );
});
