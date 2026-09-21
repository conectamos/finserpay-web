import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { resolveCarteraAliadoId } = await jiti.import(
  "../lib/cartera-access.ts"
);

test("el administrador central puede seleccionar un aliado", () => {
  assert.equal(
    resolveCarteraAliadoId({
      adminCentral: true,
      ownAliadoId: 1,
      requestedAliadoId: "24",
    }),
    24
  );
  assert.equal(
    resolveCarteraAliadoId({
      adminCentral: true,
      ownAliadoId: 1,
      requestedAliadoId: null,
    }),
    null
  );
});

test("el administrador aliado queda forzado al aliado de su sesion", () => {
  assert.equal(
    resolveCarteraAliadoId({
      adminCentral: false,
      ownAliadoId: "7",
      requestedAliadoId: "99",
    }),
    7
  );
});

test("el administrador aliado sin empresa asignada falla cerrado", () => {
  assert.equal(
    resolveCarteraAliadoId({
      adminCentral: false,
      ownAliadoId: null,
      requestedAliadoId: "99",
    }),
    null
  );
  assert.equal(
    resolveCarteraAliadoId({
      adminCentral: false,
      ownAliadoId: "dato-invalido",
      requestedAliadoId: "99",
    }),
    null
  );
});
