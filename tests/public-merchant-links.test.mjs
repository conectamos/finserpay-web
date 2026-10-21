import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { merchantMapsUrl, merchantPhoneUrl, filterPublicMerchants } = await jiti.import("../lib/public-merchant-links.ts");

test("Maps busca exactamente la dirección, incluidos tildes, numerales y símbolos", () => {
  const address = "Calle 12 # 3-53, Ibagué & Centro";
  const url = new URL(merchantMapsUrl(address));
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/search/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("query"), address);
});
test("el marcador conserva el teléfono propio del aliado y normaliza su formato", () => {
  assert.equal(merchantPhoneUrl("573124085562"), "tel:+573124085562");
  assert.equal(merchantPhoneUrl("+57 (314) 363-0462"), "tel:+573143630462");
});
test("el buscador filtra nombre y dirección, ignora tildes y conserva los datos reales", () => {
  const merchants = [
    { nombre: "CONECTAMOS", direccion: "CALLE 12 N 3 - 53 CENTRO", telefono: "573124085562" },
    { nombre: "G5 MOBILE SIN LIMITES", direccion: "Cra 5 37-94 BARRIO MAGISTERIO IBAGUÉ", telefono: "573143630462" },
  ];
  assert.deepEqual(filterPublicMerchants(merchants, "  conectamos  "), [merchants[0]]);
  assert.deepEqual(filterPublicMerchants(merchants, "ibague"), [merchants[1]]);
  assert.deepEqual(filterPublicMerchants(merchants, "magisterio"), [merchants[1]]);
  assert.deepEqual(filterPublicMerchants(merchants, ""), merchants);
  assert.deepEqual(filterPublicMerchants(merchants, "sin coincidencias"), []);
});
