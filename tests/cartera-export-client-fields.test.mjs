import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("la exportacion de cartera incluye los datos complementarios del cliente", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/api/dashboard/cartera/export/route.ts"),
    "utf8"
  );

  for (const heading of [
    "DIRECCION",
    "FECHA DE NACIMIENTO",
    "CORREO",
    "SEXO",
  ]) {
    assert.match(source, new RegExp(`<th>${heading}</th>`));
  }

  assert.match(source, /textCell\(credito\.clienteDireccion \|\| ""\)/);
  assert.match(source, /textCell\(formatDate\(credito\.clienteFechaNacimiento\)\)/);
  assert.match(source, /textCell\(credito\.clienteCorreo \|\| ""\)/);
  assert.match(source, /textCell\(credito\.clienteGenero \|\| ""\)/);
});

test("la cartera permite descargar exclusivamente los registros en mora", async () => {
  const [routeSource, pageSource] = await Promise.all([
    readFile(
      path.join(projectRoot, "app/api/dashboard/cartera/export/route.ts"),
      "utf8"
    ),
    readFile(path.join(projectRoot, "app/dashboard/cartera/page.tsx"), "utf8"),
  ]);

  assert.match(pageSource, /scope=mora/);
  assert.match(pageSource, /label="Excel mora"/);
  assert.match(routeSource, /searchParams\.get\("scope"\) === "mora"/);
  assert.match(
    routeSource,
    /installment\.estaEnMora && installment\.saldoPendiente > 0/
  );
  assert.match(routeSource, /clientes-en-mora-finserpay/);
});
