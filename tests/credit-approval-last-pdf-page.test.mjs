import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { lastPageErrorMessage, lastPageRenderSize, loadLastPdfPage, renderLastPdfPage } from "../app/dashboard/aprobaciones/last-pdf-page.ts";

const assetBase = "https://finser.test/pdfjs/6.3.289/";
const href = "/api/aprobaciones/81/documento";
const packageRoot = new URL("../node_modules/pdfjs-dist/", import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL("legacy/build/pdf.worker.mjs", packageRoot).href;

function makePdf(pageCount, options = {}) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: [300, 420], margin: 20, ...options });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    for (let page = 1; page <= pageCount; page += 1) {
      if (page > 1) document.addPage();
      document.rect(0, 0, 300, 420).fill(page === pageCount ? "#008000" : "#ff0000");
      document.fillColor("#ffffff").text(page === pageCount ? "ULTIMA HOJA FIRMADA" : "HOJA PREVIA", 20, 20);
    }
    document.end();
  });
}

function mockPdfResponse(t, bytes) {
  return t.mock.method(globalThis, "fetch", async () => new Response(Buffer.from(bytes), { headers: { "content-type": "application/pdf" } }));
}

function realLoader(requestedPages) {
  return (options) => {
    const task = pdfjs.getDocument({
      ...options,
      useWorkerFetch: false,
      standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", packageRoot)).replaceAll("\\", "/"),
      cMapUrl: fileURLToPath(new URL("cmaps/", packageRoot)).replaceAll("\\", "/"),
      wasmUrl: fileURLToPath(new URL("wasm/", packageRoot)).replaceAll("\\", "/"),
      iccUrl: fileURLToPath(new URL("iccs/", packageRoot)).replaceAll("\\", "/"),
    });
    return {
      promise: task.promise.then((document) => {
        const getPage = document.getPage.bind(document);
        document.getPage = (number) => { requestedPages.push(number); return getPage(number); };
        return document;
      }),
      destroy: () => task.destroy(),
    };
  };
}

for (const pageCount of [1, 3]) {
  test(`un PDF real de ${pageCount} hojas muestra solo la última y conserva los bytes originales`, async (t) => {
    const bytes = await makePdf(pageCount);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const request = mockPdfResponse(t, bytes);
    const requestedPages = [];
    const loaded = await loadLastPdfPage({ href, assetBase, signal: new AbortController().signal, getDocument: realLoader(requestedPages) });
    try {
      assert.deepEqual(requestedPages, [pageCount]);
      assert.equal(loaded.pageNumber, pageCount);
      assert.match(loaded.text, /ULTIMA HOJA FIRMADA/);
      assert.doesNotMatch(loaded.text, /HOJA PREVIA/);
      const canvas = createCanvas(1, 1);
      const rendered = renderLastPdfPage(loaded.page, canvas, 280, 1, 2);
      await rendered.task.promise;
      assert.equal(rendered.size.cssWidth, 280);
      assert.deepEqual([...canvas.getContext("2d").getImageData(20, 200, 1, 1).data], [0, 128, 0, 255], "El canvas corresponde a la última hoja verde, nunca a la primera roja");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
      assert.equal(request.mock.calls[0].arguments[0], href);
      assert.equal(request.mock.calls[0].arguments[1].credentials, "same-origin");
      assert.equal(request.mock.calls[0].arguments[1].cache, "no-store");
    } finally { await loaded.destroy(); }
  });
}

test("rechaza sesión denegada, respuestas ajenas a PDF y documentos vacíos antes de procesarlos", async (t) => {
  for (const response of [
    new Response("denied", { status: 403 }),
    new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    new Response("", { headers: { "content-type": "application/pdf" } }),
    new Response("%PDF", { headers: { "content-type": "application/pdf", "content-length": String(33 * 1024 * 1024) } }),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(loadLastPdfPage({ href, assetBase, signal: new AbortController().signal, getDocument() { assert.fail("No debe abrir un documento inválido"); } }), { name: "LastPdfPageError" });
    mock.mock.restore();
  }
});

test("un PDF corrupto produce error controlado sin mostrar una hoja anterior", async (t) => {
  mockPdfResponse(t, Buffer.from("Esto no es un PDF"));
  await assert.rejects(loadLastPdfPage({ href, assetBase, signal: new AbortController().signal, getDocument: realLoader([]) }), (error) => {
    assert.equal(error.name, "InvalidPDFException");
    assert.match(lastPageErrorMessage(error), /PDF firmado no se pudo leer/);
    return true;
  });
});

test("un PDF protegido por contraseña produce un estado recuperable", async (t) => {
  mockPdfResponse(t, await makePdf(1, { userPassword: "solo-prueba", ownerPassword: "solo-prueba-owner" }));
  await assert.rejects(loadLastPdfPage({ href, assetBase, signal: new AbortController().signal, getDocument: realLoader([]) }), (error) => {
    assert.equal(error.name, "PasswordException");
    assert.match(lastPageErrorMessage(error), /requiere una contraseña/);
    return true;
  });
});

test("cancelar una carga destruye el motor y descarta la respuesta tardía", async (t) => {
  mockPdfResponse(t, Buffer.from("%PDF-test"));
  const controller = new AbortController();
  let resolveDocument;
  let started;
  let destroyed = 0;
  const engineStarted = new Promise((resolve) => { started = resolve; });
  const result = loadLastPdfPage({ href, assetBase, signal: controller.signal, getDocument(options) {
    assert.equal(options.cMapUrl, `${assetBase}cmaps/`);
    assert.equal(options.standardFontDataUrl, `${assetBase}standard_fonts/`);
    assert.equal(options.wasmUrl, `${assetBase}wasm/`);
    assert.equal(options.iccUrl, `${assetBase}iccs/`);
    assert.equal(options.enableXfa, false);
    assert.equal(options.stopAtErrors, true);
    started();
    return { promise: new Promise((resolve) => { resolveDocument = resolve; }), destroy: async () => { destroyed += 1; } };
  } });
  await engineStarted;
  controller.abort();
  resolveDocument({ numPages: 1, getPage() { assert.fail("La carga cancelada no debe mostrar contenido"); } });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(destroyed, 1);
});

test("dimensiones móviles ajustan el ancho, el zoom amplía y el canvas tiene límite de memoria", () => {
  const page = { getViewport: ({ scale }) => ({ width: 300 * scale, height: 420 * scale }) };
  assert.equal(lastPageRenderSize(page, 280, 1, 2).cssWidth, 280);
  assert.equal(lastPageRenderSize(page, 280, 2, 2).cssWidth, 560);
  for (const [width, zoom, density] of [[280, 3, 3], [3000, 3, 4], [12000, 3, 4]]) {
    const size = lastPageRenderSize(page, width, zoom, density);
    assert.ok(size.pixelWidth <= 4096 && size.pixelHeight <= 4096);
    assert.ok(size.pixelWidth * size.pixelHeight <= 12_000_000);
  }
  const rotatedPage = { getViewport: ({ scale }) => ({ width: 420 * scale, height: 300 * scale }) };
  assert.equal(lastPageRenderSize(rotatedPage, 280, 1, 2).cssHeight, 200);
  assert.throws(() => lastPageRenderSize({ getViewport: () => ({ width: 0, height: 300 }) }, 280, 1, 1), /dimensiones no válidas/);
});

test("el render conserva apariencias de firma y evita controles editables", async () => {
  let options;
  const page = { getViewport: ({ scale }) => ({ width: 300 * scale, height: 420 * scale }), render(value) { options = value; return { promise: Promise.resolve() }; } };
  const canvas = { getContext: () => ({}) };
  const rendered = renderLastPdfPage(page, canvas, 280, 1, 1);
  await rendered.task.promise;
  assert.equal(options.annotationMode, pdfjs.AnnotationMode.ENABLE);
  assert.equal(options.isEditing, false);
  assert.equal(options.intent, "display");
  assert.equal(options.canvas, canvas);
  assert.equal(lastPageErrorMessage(new Error("internal/private/document/base64")), "No se pudo mostrar la última página. Intenta cargarla de nuevo.");
});
