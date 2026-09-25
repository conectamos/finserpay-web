import assert from "node:assert/strict";
import test from "node:test";

import { resolveContractualCreditImei } from "../lib/credit-contract-imei.ts";

test("el IMEI contractual queda congelado aunque cambie el equipo operativo", () => {
  assert.equal(
    resolveContractualCreditImei({
      imei: "352228709273867",
      deviceUid: "352228709273867",
      contratoSnapshot: {
        equipo: { imei: "354627901806291" },
        financiero: {
          selloFinanciero: {
            snapshot: { imei: "354627901806291" },
          },
        },
      },
    }),
    "354627901806291"
  );
});

test("el resolver conserva compatibilidad con snapshots y créditos legados", () => {
  assert.equal(
    resolveContractualCreditImei({
      imei: "352228709273867",
      contratoSnapshot: { equipo: { imei: "354627901806291" } },
    }),
    "354627901806291"
  );
  assert.equal(
    resolveContractualCreditImei({ imei: "352228709273867" }),
    "352228709273867"
  );
});

test("un CSV histórico sin firma usa el IMEI corregido sin modificar el snapshot original", () => {
  const credit = {
    imei: "352228709273867",
    deviceUid: "352228709273867",
    contratoSnapshot: {
      origen: {
        tipo: "IMPORTACION_MASIVA",
        sinFirmaDigital: true,
        imeiTemporalPendienteCorreccion: false,
      },
      equipo: { imei: "100000000000001", imeiTemporal: true },
    },
  };
  assert.equal(resolveContractualCreditImei(credit), "352228709273867");
  credit.contratoSnapshot.origen.imeiTemporalPendienteCorreccion = true;
  assert.equal(resolveContractualCreditImei(credit), "100000000000001");

  credit.contratoSnapshot.origen.imeiTemporalPendienteCorreccion = false;
  credit.contratoSnapshot.financiero = {
    selloFinanciero: { snapshot: { imei: "354627901806291" } },
  };
  assert.equal(resolveContractualCreditImei(credit), "354627901806291");
});
