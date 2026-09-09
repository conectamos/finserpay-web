import type { PDFPageProxy } from "pdfjs-dist";

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 12_000_000;
const MAX_CANVAS_SIDE = 4096;

class LastPdfPageError extends Error {
  name = "LastPdfPageError";
}

type PdfLoader = typeof import("pdfjs-dist").getDocument;

export async function loadLastPdfPage({
  href,
  assetBase,
  signal,
  getDocument,
}: {
  href: string;
  assetBase: string;
  signal: AbortSignal;
  getDocument: PdfLoader;
}) {
  const response = await fetch(href, { cache: "no-store", credentials: "same-origin", signal });
  if (!response.ok) throw new LastPdfPageError(response.status === 401 || response.status === 403
    ? "Tu sesión no permite abrir este documento. Vuelve a iniciar sesión."
    : "No se pudo cargar el documento firmado. Intenta de nuevo.");
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    throw new LastPdfPageError("La respuesta recibida no es un PDF firmado.");
  }
  if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) {
    throw new LastPdfPageError("El documento supera el tamaño admitido para esta vista.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new LastPdfPageError("El documento está vacío o supera el tamaño admitido.");
  if (signal.aborted) throw new DOMException("Carga cancelada", "AbortError");

  const loading = getDocument({
    data: bytes,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
    useWorkerFetch: true,
    stopAtErrors: true,
    enableXfa: false,
  });
  let destroyed = false;
  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    signal.removeEventListener("abort", abort);
    await loading.destroy();
  }
  function abort() { void destroy().catch(() => undefined); }
  signal.addEventListener("abort", abort, { once: true });
  try {
    const document = await loading.promise;
    if (signal.aborted) throw new DOMException("Carga cancelada", "AbortError");
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.isPureXfa) {
      throw new LastPdfPageError("No se pudo identificar la última página del documento.");
    }
    const page = await document.getPage(document.numPages);
    if (signal.aborted) throw new DOMException("Carga cancelada", "AbortError");
    const content = await page.getTextContent();
    const text = content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ");
    if (signal.aborted) throw new DOMException("Carga cancelada", "AbortError");
    return { page, pageNumber: document.numPages, text, destroy };
  } catch (error) {
    await destroy().catch(() => undefined);
    throw error;
  }
}

export function lastPageRenderSize(page: Pick<PDFPageProxy, "getViewport">, containerWidth: number, zoom: number, deviceScale: number) {
  const original = page.getViewport({ scale: 1 });
  if (!(original.width > 0 && original.height > 0 && Number.isFinite(original.width + original.height))) {
    throw new LastPdfPageError("La última página tiene dimensiones no válidas.");
  }
  const fittedWidth = Math.max(120, Number.isFinite(containerWidth) ? containerWidth : 120);
  const normalizedZoom = Math.min(3, Math.max(1, Number.isFinite(zoom) ? zoom : 1));
  const cssWidth = fittedWidth * normalizedZoom;
  const cssHeight = cssWidth * original.height / original.width;
  const density = Math.min(
    Math.max(1, Number.isFinite(deviceScale) ? deviceScale : 1),
    2,
    Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)),
    MAX_CANVAS_SIDE / Math.max(cssWidth, cssHeight),
  );
  const viewport = page.getViewport({ scale: cssWidth / original.width * density });
  return { viewport, cssWidth, cssHeight, pixelWidth: Math.max(1, Math.floor(viewport.width)), pixelHeight: Math.max(1, Math.floor(viewport.height)) };
}

export function lastPageErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "PasswordException") return "El PDF requiere una contraseña y no se puede mostrar aquí.";
  if (error instanceof Error && error.name === "InvalidPDFException") return "El PDF firmado no se pudo leer. Actualiza el expediente o solicita su revisión.";
  return error instanceof Error && error.name === "LastPdfPageError"
    ? error.message
    : "No se pudo mostrar la última página. Intenta cargarla de nuevo.";
}

export function renderLastPdfPage(page: PDFPageProxy, canvas: HTMLCanvasElement, containerWidth: number, zoom: number, deviceScale: number) {
  const size = lastPageRenderSize(page, containerWidth, zoom, deviceScale);
  canvas.width = size.pixelWidth;
  canvas.height = size.pixelHeight;
  if (!canvas.getContext("2d")) throw new LastPdfPageError("Tu navegador no pudo preparar la vista del PDF.");
  const task = page.render({
    canvas,
    viewport: size.viewport,
    intent: "display",
    // AnnotationMode.ENABLE includes signature/form appearance streams.
    annotationMode: 1,
    isEditing: false,
    background: "rgb(255,255,255)",
  });
  return { task, size };
}