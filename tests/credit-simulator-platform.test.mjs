import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../app/dashboard/creditos/page.tsx", import.meta.url),
  "utf8"
);
const selector = readFileSync(
  new URL("../app/dashboard/creditos/credit-platform-selector.tsx", import.meta.url),
  "utf8"
);
const sidebar = readFileSync(
  new URL("../app/dashboard/_components/admin-sidebar.tsx", import.meta.url),
  "utf8"
);
const dashboard = readFileSync(
  new URL("../app/dashboard/_components/admin-central-dashboard.tsx", import.meta.url),
  "utf8"
);

test("el simulador exige escoger Android o iPhone antes de calcular", () => {
  assert.match(
    page,
    /\(entryMode === "create-client" \|\| entryMode === "simulator"\)\s*&&\s*!devicePlatform/
  );
  assert.match(page, /params\.set\("mode", entryMode\)/);
  assert.match(page, /mode=\{entryMode === "simulator" \? "simulator" : "sale"\}/);
  assert.match(page, /devicePlatform \|\| "sin-plataforma"/);
  assert.match(selector, /mode\?: "sale" \| "simulator"/);
  assert.match(selector, /actionLabel=\{simulatorMode \? "Simular Android"/);
  assert.match(selector, /actionLabel=\{simulatorMode \? "Simular iPhone"/);
});

test("el administrador central ve el simulador en menu y acciones rapidas", () => {
  assert.match(
    sidebar,
    /adminCentral[\s\S]{0,320}href: "\/dashboard\/creditos\?mode=simulator"/
  );
  assert.match(
    dashboard,
    /adminCentral \? \([\s\S]{0,260}href="\/dashboard\/creditos\?mode=simulator"/
  );
});
