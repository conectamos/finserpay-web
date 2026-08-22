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

const [evidenceRoute, evidenceGallery, factoryConsole] = await Promise.all([
  readProjectFile("app/api/creditos/[id]/evidencias/route.ts"),
  readProjectFile("app/dashboard/creditos/credit-evidence-gallery.tsx"),
  readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
]);

test("expone de forma autenticada las cinco evidencias del cierre iPhone", () => {
  for (const field of [
    "contratoCedulaFrenteDataUrl",
    "contratoCedulaRespaldoDataUrl",
    "iphoneSelfieCedulaDataUrl",
    "fotoEntregaDataUrl",
    "fotoRemisionDataUrl",
  ]) {
    assert.match(evidenceRoute, new RegExp(field));
  }

  assert.match(evidenceRoute, /isAdminRole/);
  assert.match(evidenceRoute, /tipoPerfil === "SUPERVISOR"/);
  assert.match(evidenceRoute, /buildCreditAccessWhere/);
  assert.match(evidenceRoute, /Content-Type/);
  assert.match(evidenceRoute, /private, no-store/);
});

test("documentos carga las evidencias bajo demanda y permite verlas o descargarlas", () => {
  assert.match(factoryConsole, /import CreditEvidenceGallery/);
  assert.match(factoryConsole, /<CreditEvidenceGallery/);
  assert.match(factoryConsole, /creditId={selectedCredit.id}/);
  assert.match(evidenceGallery, /fetch\(\`\/api\/creditos\/\$\{creditId\}\/evidencias\`/);
  assert.match(evidenceGallery, /download=1/);
  assert.match(evidenceGallery, /No disponible/);
  assert.match(evidenceGallery, /data\.items\.map/);
});
