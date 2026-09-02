import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getSolicitudActions } from "../lib/solicitudes.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const [page, component, wall] = await Promise.all([
  readProjectFile("app/dashboard/creditos/page.tsx"),
  readProjectFile(
    "app/dashboard/creditos/approved-credit-equipment-replacement.tsx"
  ),
  readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
]);

const ownership = {
  aliadoId: 10,
  sedeId: 20,
  vendedorId: 30,
  usuarioId: 40,
};

test("solo el administrador central recibe la accion de cambio para un credito aprobado", () => {
  const centralActions = getSolicitudActions({
    viewer: {
      kind: "CENTRAL_ADMIN",
      userId: 1,
      aliadoId: null,
      sedeId: null,
      vendedorId: null,
    },
    ownership,
    source: "CREDIT",
    state: "APROBADA",
    platform: "IPHONE",
  });

  assert.ok(centralActions.includes("CAMBIO_GARANTIA"));

  for (const kind of ["ALLY_ADMIN", "SUPERVISOR", "SELLER"]) {
    const actions = getSolicitudActions({
      viewer: {
        kind,
        userId: 2,
        aliadoId: 10,
        sedeId: 20,
        vendedorId: kind === "SELLER" ? 30 : null,
      },
      ownership,
      source: "CREDIT",
      state: "APROBADA",
      platform: "IPHONE",
    });
    assert.equal(actions.includes("CAMBIO_GARANTIA"), false);
  }

  const cancelledActions = getSolicitudActions({
    viewer: {
      kind: "CENTRAL_ADMIN",
      userId: 1,
      aliadoId: null,
      sedeId: null,
      vendedorId: null,
    },
    ownership,
    source: "CREDIT",
    state: "CANCELADA",
    platform: "IPHONE",
  });
  assert.equal(cancelledActions.includes("CAMBIO_GARANTIA"), false);

  const androidActions = getSolicitudActions({
    viewer: {
      kind: "CENTRAL_ADMIN",
      userId: 1,
      aliadoId: null,
      sedeId: null,
      vendedorId: null,
    },
    ownership,
    source: "CREDIT",
    state: "APROBADA",
    platform: "ANDROID",
  });
  assert.equal(androidActions.includes("CAMBIO_GARANTIA"), false);
});

test("la URL directa replacement exige admin central y un credito seleccionado", () => {
  assert.match(page, /rawEntryMode === "replacement"/);
  assert.match(
    page,
    /rawEntryMode === "replacement"[\s\S]{0,260}!adminCentral[\s\S]{0,260}redirect\("\/dashboard\/solicitudes"\)/
  );
  assert.match(page, /ApprovedCreditEquipmentReplacement/);
  assert.match(page, /creditId=\{initialSelectedId\}/);
  assert.match(page, /Volver al muro/);
});

test("el muro muestra una accion separada en escritorio, movil y detalle", () => {
  assert.match(
    wall,
    /mode=replacement&selected=\$\{encodeURIComponent\(rawId\(item\.id\)\)\}/
  );
  assert.match(wall, /params\.set\("returnTo", returnTo\)/);
  assert.ok(
    (wall.match(/actions\.includes\("CAMBIO_GARANTIA"\)/g) || []).length >= 3
  );
  assert.match(wall, /Cambio garantía/);
  assert.match(wall, /Cambio por garantía/);
  assert.match(wall, /replacementHref\(detail, wallReturnHref\)/);
});

test("la pantalla crea, consulta y aplica el reemplazo con confirmacion", () => {
  assert.match(component, /\/device-replacement/);
  assert.match(component, /method: "POST"/);
  assert.match(component, /JSON\.stringify\(\{ newImei: normalizedImei, reason: normalizedReason \}\)/);
  assert.match(component, /method: "PATCH"/);
  assert.match(component, /\{ action \}/);
  assert.match(component, /action === "COMPLETE"/);
  assert.match(component, /ConfirmDialog/);
  assert.match(component, /Aplicar cambio/);
  assert.doesNotMatch(component, /window\.confirm/);
});

test("la pantalla representa los cuatro estados y no aplica antes del enrolamiento", () => {
  for (const status of [
    "PENDING_ENROLLMENT",
    "ENROLLMENT_APPROVED",
    "COMPLETED",
    "CANCELLED",
  ]) {
    assert.match(component, new RegExp(status));
  }

  assert.match(
    component,
    /replacement\.status === "ENROLLMENT_APPROVED"[\s\S]{0,1800}setConfirmAction\("COMPLETE"\)/
  );
  assert.match(component, /portal de enrolamiento/);
  assert.match(component, /IMEI anterior se conserva/);
});

test("la interfaz es responsive, enmascara los identificadores y usa tokens FINSER PAY", () => {
  assert.match(component, /clienteDocumentoMasked/);
  assert.match(component, /currentImeiMasked/);
  assert.match(component, /newImeiMasked/);
  assert.match(component, /sm:grid-cols/);
  assert.match(component, /xl:grid-cols/);
  assert.match(component, /var\(--fp-graphite\)/);
  assert.match(component, /var\(--fp-lime-soft\)/);
  assert.match(component, /var\(--fp-amber-soft\)/);
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}|rgba\(/i);
});
