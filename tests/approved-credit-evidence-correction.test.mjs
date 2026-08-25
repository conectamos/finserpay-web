import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const [route, gallery, page] = await Promise.all([
  readProjectFile("app/api/creditos/[id]/evidencias/route.ts"),
  readProjectFile("app/dashboard/creditos/credit-evidence-gallery.tsx"),
  readProjectFile("app/dashboard/creditos/page.tsx"),
]);

test("la correccion de evidencias exige administrador central en GET y PATCH", () => {
  assert.match(route, /export async function PATCH/);
  assert.match(
    route,
    /isAdminRole\(user\.rolNombre\)\s*&&\s*isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/
  );
  assert.match(route, /correctionMode && !adminCentral/);
  assert.match(
    route,
    /Solo el administrador central de FINSER PAY puede (?:abrir la correccion|corregir evidencias)/
  );
  assert.match(route, /\{ status: 403 \}/);
});

test("la lectura de cedula, selfie y entrega rechaza vendedores y supervisores", () => {
  assert.match(route, /const admin = isAdminRole\(user\.rolNombre\)/);
  assert.match(route, /if \(!admin\)/);
  assert.match(route, /Solo administradores pueden consultar evidencias/);
  assert.doesNotMatch(route, /tipoPerfil === "SUPERVISOR"/);
  assert.match(route, /sellerSedeId: null/);
  assert.match(route, /supervisor: false/);
});

test("la URL directa de la fabrica tambien exige administrador central", () => {
  assert.match(page, /rawEntryMode === "correction"/);
  assert.match(
    page,
    /!adminCentral[\s\S]{0,220}redirect\("\/dashboard\/solicitudes"\)/
  );
  assert.match(page, /ApprovedCreditEvidenceCorrection/);
});

test("PATCH solo acepta una de las cinco imagenes autorizadas y la valida con decodificacion real", () => {
  for (const key of [
    "cedula-frente",
    "cedula-posterior",
    "selfie-cedula",
    "foto-entrega",
    "foto-remision",
  ]) {
    assert.match(route, new RegExp(`"${key}"`));
  }

  assert.match(route, /keys\.length !== 2/);
  assert.match(route, /keys\[0\] !== "dataUrl"/);
  assert.match(route, /keys\[1\] !== "key"/);
  assert.match(route, /EVIDENCE_KEYS\.includes\(body\.key as EvidenceKey\)/);
  assert.match(route, /sanitizeIphoneDeliveryEvidenceDataUrl\(correction\.dataUrl\)/);
});

test("la correccion actualiza solo la evidencia elegida y el snapshot auditado", () => {
  for (const field of [
    "contratoCedulaFrenteDataUrl",
    "contratoCedulaRespaldoDataUrl",
    "iphoneSelfieCedulaDataUrl",
    "fotoEntregaDataUrl",
    "fotoRemisionDataUrl",
  ]) {
    assert.match(route, new RegExp(field));
  }

  assert.match(route, /creditEvidenceUpdateData\(correction\.key, sanitizedDataUrl\)/);
  assert.match(route, /contratoSnapshot: contratoSnapshot as Prisma\.InputJsonValue/);
  assert.match(route, /correccionesEvidencia/);
  assert.match(route, /previousSha256/);
  assert.match(route, /nextSha256/);
  assert.match(route, /correctedAt/);
  assert.match(route, /actor: \{/);
  assert.match(route, /source: "CORRECCION_ADMIN_CENTRAL"/);
  const updateBlock = route.match(
    /const updated = await prisma\.credito\.update\(\{([\s\S]*?)\n    \}\);/
  )?.[1];
  assert.ok(updateBlock, "debe existir una unica actualizacion del credito");
  assert.doesNotMatch(updateBlock, /\bestado\s*:/);
});

test("las ventas canceladas nunca admiten reemplazo de evidencias", () => {
  for (const state of ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"]) {
    assert.match(route, new RegExp(`"${state}"`));
  }

  assert.match(route, /isCancelledCreditState\(credit\.estado\)/);
  assert.match(route, /\{ status: 409 \}/);
});

test("GET correction entrega el resumen protegido sin exponerlo al modo de lectura normal", () => {
  assert.match(route, /searchParams\.get\("correction"\) === "1"/);
  assert.match(route, /summary: correctionMode/);
  assert.match(route, /clientName: credito\.clienteNombre/);
  assert.match(route, /document: credito\.clienteDocumento/);
  assert.match(route, /imei: credito\.imei/);
  assert.match(route, /referenciaEquipo/);
  assert.match(
    route,
    /canCorrect:\s*correctionMode && adminCentral && !isCancelledCreditState/
  );
});

test("el componente correction es responsive, confirma el reemplazo y usa PATCH", () => {
  assert.match(gallery, /export function ApprovedCreditEvidenceCorrection/);
  assert.match(
    gallery,
    /Pick<Props, "creditId" \| "clientName">/
  );
  assert.match(gallery, /evidencias\?correction=1/);
  assert.match(gallery, /method: "PATCH"/);
  assert.match(gallery, /window\.confirm/);
  assert.match(gallery, /accept="image\/png,image\/jpeg"/);
  assert.match(gallery, /sm:grid-cols-2/);
  assert.match(gallery, /lg:grid-cols-3/);
  assert.match(gallery, /xl:grid-cols-5/);
  assert.match(gallery, /data\.summary\?\.clientName \|\| clientName/);
});

test("el flujo de correccion no llama DataCredito, Veriff ni FirmaSeguro", () => {
  assert.doesNotMatch(route, /datacredito|veriff|firmaseguro/i);
  assert.match(
    gallery,
    /Este flujo no vuelve a consultar DataCredito, Veriff ni FirmaSeguro/
  );
});
