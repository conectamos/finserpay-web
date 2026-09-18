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
