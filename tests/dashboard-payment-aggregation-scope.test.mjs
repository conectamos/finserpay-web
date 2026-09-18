import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(
  new URL("../app/dashboard/_lib/admin-dashboard-data.ts", import.meta.url),
  "utf8"
);
const reportsSource = readFileSync(
  new URL("../app/dashboard/reportes/page.tsx", import.meta.url),
  "utf8"
);

function paymentTotalsQuery(source) {
  const start = source.indexOf("prisma.creditoAbono.groupBy({");
  const end = source.indexOf("prisma.creditoAbono.", start + 1);
  assert.ok(start >= 0, "debe agrupar los abonos por crédito");
  assert.ok(end > start, "debe cerrar el bloque antes de la siguiente consulta");
  return source.slice(start, end);
}

test("los saldos agrupan todos los abonos del crédito aunque se recauden en otra sede", () => {
  for (const source of [dashboardSource, reportsSource]) {
    const query = paymentTotalsQuery(source);
    assert.match(query, /credito:\s*\{\s*\.\.\.creditWhere/);
    assert.doesNotMatch(query, /sedeId:\s*\{\s*in:\s*scopeSedeIds/);
    assert.doesNotMatch(query, /\.\.\.scope/);
  }
});
