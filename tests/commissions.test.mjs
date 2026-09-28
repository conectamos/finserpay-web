import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { commissionRate, commissionPeriodAt, commissionsAreActive, calculateCommissionPeriod, validateCommissionRequest } = await jiti.import("../lib/commissions.ts");

test("inicio exacto en Colombia: 30 septiembre 23:59:59 y 1 octubre 00:00", () => {
  assert.equal(commissionsAreActive(new Date("2026-10-01T04:59:59.999Z")), false);
  assert.equal(commissionsAreActive(new Date("2026-10-01T05:00:00.000Z")), true);
  assert.equal(commissionPeriodAt(new Date("2026-11-01T04:59:59Z")), "2026-10");
  assert.equal(commissionPeriodAt(new Date("2026-11-01T05:00:00Z")), "2026-11");
});

test("todos los umbrales aplican a todos los créditos y continúan tras 30", () => {
  for (const [count, rate, total] of [[0,0,0],[14,0,0],[15,20000,300000],[16,20000,320000],[20,20000,400000],[21,25000,525000],[29,25000,725000],[30,30000,900000],[31,30000,930000],[100,30000,3000000]]) {
    assert.equal(commissionRate(count), rate);
    assert.equal(calculateCommissionPeriod("2026-10", count).generated, total);
  }
});

test("recálculo retroactivo descuenta pagos y reservas, y ajustes nunca son saldos negativos", () => {
  assert.equal(calculateCommissionPeriod("2026-10",21,200000,100000).available,225000);
  const adjusted=calculateCommissionPeriod("2026-10",14,200000,0);
  assert.equal(adjusted.available,0);
  assert.equal(adjusted.adjustment,200000);
});

test("monto entero positivo, mes válido, Nequi y clave de operación obligatorios", () => {
  const valid={period:"2026-10",amount:50000,nequi:"312 408 5562",idempotencyKey:"operation-00000001"};
  assert.equal(validateCommissionRequest(valid,"2026-10").nequi,"3124085562");
  for (const patch of [{amount:0},{amount:-1},{amount:0.5},{amount:NaN},{period:"2026-09"},{period:"2026-11"},{period:"2026-13"},{nequi:"0124085562"},{idempotencyKey:""}]) {
    assert.throws(()=>validateCommissionRequest({...valid,...patch},"2026-10"));
  }
});
