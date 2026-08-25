import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { canAccessVeriffValidation, canOperateVeriffDraft } =
  await jiti.import("../lib/veriff-access.ts");
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const central = {
  aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 1,
  id: 1,
  rolNombre: "ADMIN",
  sedeId: 1,
};
const allyAdmin = {
  aliadoAccesoCodigo: "ALIADO-10",
  aliadoAccesoId: 10,
  id: 2,
  rolNombre: "ADMIN",
  sedeId: 100,
};
const sellerUser = {
  aliadoAccesoCodigo: "ALIADO-10",
  aliadoAccesoId: 10,
  id: 3,
  rolNombre: "ASESOR",
  sedeId: 100,
};
const owner = { id: 50, sedeId: 100 };
const otherSellerSameSede = { id: 51, sedeId: 100 };
const ownerRow = {
  aliadoId: 10,
  estado: "ABIERTO",
  sedeId: 100,
  usuarioId: sellerUser.id,
  vendedorId: owner.id,
};

test("Veriff respeta alcance central, aliado y asesor titular", () => {
  assert.equal(canAccessVeriffValidation(central, ownerRow, null), true);
  assert.equal(canAccessVeriffValidation(allyAdmin, ownerRow, null), true);
  assert.equal(
    canAccessVeriffValidation(
      { ...allyAdmin, aliadoAccesoId: 11 },
      ownerRow,
      null
    ),
    false
  );
  assert.equal(canAccessVeriffValidation(sellerUser, ownerRow, owner), true);
  assert.equal(
    canAccessVeriffValidation(sellerUser, ownerRow, otherSellerSameSede),
    false
  );
  assert.equal(
    canAccessVeriffValidation(
      sellerUser,
      { ...ownerRow, usuarioId: sellerUser.id },
      otherSellerSameSede
    ),
    false,
    "compartir usuario o sede no concede acceso"
  );
  assert.equal(
    canAccessVeriffValidation(
      sellerUser,
      ownerRow,
      { ...owner, sedeId: 101 }
    ),
    false
  );
  assert.equal(canAccessVeriffValidation(sellerUser, ownerRow, null), false);
});

test("solo un borrador abierto y dentro del alcance puede iniciar Veriff", () => {
  assert.equal(canOperateVeriffDraft(central, ownerRow, null), true);
  assert.equal(canOperateVeriffDraft(allyAdmin, ownerRow, null), true);
  assert.equal(canOperateVeriffDraft(sellerUser, ownerRow, owner), true);
  assert.equal(
    canOperateVeriffDraft(
      sellerUser,
      { ...ownerRow, estado: "CERRADO" },
      owner
    ),
    false
  );
  assert.equal(
    canOperateVeriffDraft(sellerUser, ownerRow, otherSellerSameSede),
    false
  );
});

test("POST autoriza el borrador y la cedula antes de reusar o llamar al proveedor", async () => {
  const route = await readProjectFile("app/api/creditos/veriff/route.ts");
  const access = route.indexOf(
    "if (!draft || !canOperateVeriffDraft(user, draft, sellerSession))"
  );
  const reuse = route.indexOf("getReusableVeriffValidationForDraft({");
  const provider = route.indexOf("await veriffCreateSession({");

  assert.match(route, /FROM "CreditoBorrador" d/);
  assert.match(route, /draft\.clienteDocumento/);
  assert.match(route, /requestedDocument !== clienteDocumento/);
  assert.ok(access >= 0);
  assert.ok(reuse > access);
  assert.ok(provider > reuse);
  assert.match(route, /aliadoId: draft\.aliadoId/);
  assert.match(route, /sedeId: draft\.sedeId/);
  assert.match(route, /vendedorId: draft\.vendedorId/);
});

test("consulta, refresco y descarga Veriff exigen la sesion del asesor titular", async () => {
  const files = [
    "app/api/creditos/veriff/[id]/route.ts",
    "app/api/creditos/veriff/[id]/media/route.ts",
    "app/api/creditos/veriff/[id]/media/[mediaId]/route.ts",
  ];
  const routes = await Promise.all(files.map(readProjectFile));

  for (const route of routes) {
    assert.match(route, /getSellerSessionUser\(user\)/);
    assert.match(
      route,
      /canAccessVeriffValidation\(user, (?:current|validation), sellerSession\)/
    );
  }

  const access = await readProjectFile("lib/veriff-access.ts");
  assert.doesNotMatch(access, /row\.sedeId === user\.sedeId \|\|/);
  assert.doesNotMatch(access, /row\.usuarioId === user\.id/);
  assert.match(access, /row\.vendedorId === seller\.id/);
  assert.match(access, /row\.sedeId === seller\.sedeId/);
});
