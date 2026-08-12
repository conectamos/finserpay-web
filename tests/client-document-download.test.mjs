import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const { clientPdfFilename, fetchClientPdf } = await jiti.import(
  "../lib/client-document-download.ts"
);

test("prepara el PDF y conserva el nombre entregado por el servidor", async () => {
  const result = await fetchClientPdf(
    "/api/clientes/creditos/54/paz-y-salvo",
    "paz-y-salvo.pdf",
    async (href, init) => {
      assert.equal(href, "/api/clientes/creditos/54/paz-y-salvo");
      assert.equal(init.cache, "no-store");
      assert.equal(init.credentials, "same-origin");

      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
        headers: {
          "Content-Disposition":
            'attachment; filename="paz-y-salvo-FC-2026.pdf"',
          "Content-Type": "application/pdf",
        },
      });
    }
  );

  assert.equal(result.filename, "paz-y-salvo-FC-2026.pdf");
  assert.equal(result.blob.size, 5);
});

test("muestra el error funcional que responde el endpoint", async () => {
  await assert.rejects(
    fetchClientPdf("/paz-y-salvo", "paz-y-salvo.pdf", async () =>
      Response.json(
        { error: "El credito todavia tiene saldo pendiente" },
        { status: 409 }
      )
    ),
    /El credito todavia tiene saldo pendiente/
  );
});

test("rechaza respuestas que no sean un PDF", async () => {
  await assert.rejects(
    fetchClientPdf("/paz-y-salvo", "paz-y-salvo.pdf", async () =>
      Response.json({ ok: true })
    ),
    /no entrego un archivo PDF valido/
  );
});

test("rechaza contenido falso aunque anuncie application/pdf", async () => {
  await assert.rejects(
    fetchClientPdf("/paz-y-salvo", "paz-y-salvo.pdf", async () =>
      new Response("error", {
        headers: { "Content-Type": "application/pdf" },
      })
    ),
    /archivo PDF invalido/
  );
});

test("normaliza nombres codificados y evita rutas en el archivo", () => {
  assert.equal(
    clientPdfFilename(
      "attachment; filename*=UTF-8''paz%20y%20salvo%2Fcliente.pdf",
      "paz-y-salvo.pdf"
    ),
    "paz y salvo-cliente.pdf"
  );
});

test("la app Android expone la descarga nativa en una version nueva", async () => {
  const [activity, buildConfig] = await Promise.all([
    readFile(
      path.join(
        projectRoot,
        "android-client/app/src/main/java/com/finserpay/clientes/MainActivity.java"
      ),
      "utf8"
    ),
    readFile(
      path.join(projectRoot, "android-client/app/build.gradle.kts"),
      "utf8"
    ),
  ]);

  assert.match(activity, /@JavascriptInterface\s+public void downloadDocument\(/);
  assert.match(activity, /runOnUiThread\(\(\) -> requestDownload\(/);
  assert.match(activity, /isAllowedClientDocumentDownload\(url\)/);
  assert.match(activity, /\(\?:paz-y-salvo\|folio-firmado\)/);
  assert.match(buildConfig, /versionCode\s*=\s*7/);
  assert.match(buildConfig, /versionName\s*=\s*"1\.0\.6"/);
});

test("el folio firmado valida propietario y entrega solo un PDF privado", async () => {
  const route = await readFile(
    path.join(
      projectRoot,
      "app/api/clientes/creditos/[id]/folio-firmado/route.ts"
    ),
    "utf8"
  );

  assert.match(route, /clienteDocumento:\s*documento/);
  assert.match(route, /estado:\s*\{\s*not:\s*"ANULADO"\s*\}/);
  assert.match(route, /toString\("ascii"\)\s*!==\s*"%PDF-"/);
  assert.match(route, /"Cache-Control":\s*"private, no-store, max-age=0"/);
  assert.match(route, /"X-Content-Type-Options":\s*"nosniff"/);
});
