"use client";

import { useEffect, useRef, useState } from "react";
import type { RenderTask } from "pdfjs-dist";
import { Maximize2, Minus, Plus, RefreshCw } from "lucide-react";
import { Button, LoadingState } from "@/app/_components/finser-ui";
import { lastPageErrorMessage, renderLastPdfPage, loadLastPdfPage } from "./last-pdf-page";

type LastPage = Awaited<ReturnType<typeof loadLastPdfPage>>;

export default function LastPdfPagePreview({ href, folio }: { href: string; folio: string }) {
  const [page, setPage] = useState<LastPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const renderQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const controller = new AbortController();
    let loaded: LastPage | null = null;
    async function load() {
      setLoading(true);
      setPage(null);
      setError("");
      try {
        // Import after hydration: PDF.js needs browser APIs. Assets and worker
        // come from the same pinned package and are served by this application.
        const pdfjs = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        const assetBase = new URL(`/pdfjs/${pdfjs.version}/`, window.location.origin).href;
        pdfjs.GlobalWorkerOptions.workerSrc = `${assetBase}pdf.worker.min.mjs`;
        loaded = await loadLastPdfPage({ href, assetBase, signal: controller.signal, getDocument: pdfjs.getDocument });
        if (!controller.signal.aborted) setPage(loaded);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(lastPageErrorMessage(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      void loaded?.destroy().catch(() => undefined);
    };
  }, [href, retry]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const target = canvas.current;
    if (!page || !target || !width) return;
    let active = true;
    let task: RenderTask | null = null;
    // Await cancelled renders before reusing the canvas for a new zoom/width.
    renderQueue.current = renderQueue.current.catch(() => undefined).then(async () => {
      if (!active) return;
      setRendering(true);
      setError("");
      try {
        const rendered = renderLastPdfPage(page.page, target, width, zoom, window.devicePixelRatio || 1);
        task = rendered.task;
        target.style.width = `${rendered.size.cssWidth}px`;
        target.style.height = `${rendered.size.cssHeight}px`;
        await task.promise;
      } catch (renderError) {
        if (active) setError(lastPageErrorMessage(renderError));
      } finally {
        if (active) setRendering(false);
      }
    });
    return () => { active = false; task?.cancel(); };
  }, [page, width, zoom]);

  return (
    <div className="relative min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--fp-muted)]">{page ? `Última página · ${page.pageNumber} de ${page.pageNumber}` : "Última página del documento firmado"}</p>
        <div className="flex flex-wrap items-center gap-2" aria-label="Ampliación del documento">
          <Button variant="secondary" aria-label="Reducir última página" disabled={!page || loading || zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.25))}><Minus className="h-4 w-4" aria-hidden="true" /></Button>
          <span className="min-w-12 text-center text-sm tabular-nums" aria-live="polite">{Math.round(zoom * 100)} %</span>
          <Button variant="secondary" aria-label="Ampliar última página" disabled={!page || loading || zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))}><Plus className="h-4 w-4" aria-hidden="true" /></Button>
          <Button variant="ghost" disabled={!page || loading || zoom === 1} onClick={() => setZoom(1)}><Maximize2 className="h-4 w-4" aria-hidden="true" />Ajustar</Button>
        </div>
      </div>
      {loading ? <LoadingState label="Cargando la última página del documento firmado..." /> : null}
      {error ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4"><p className="text-sm text-[var(--fp-danger)]" role="alert">{error}</p><Button variant="secondary" onClick={() => setRetry((value) => value + 1)}><RefreshCw className="h-4 w-4" aria-hidden="true" />Reintentar</Button></div> : null}
      {rendering && !loading ? <p className="text-sm text-[var(--fp-muted)]" role="status">Preparando la vista...</p> : null}
      <div ref={container} className="min-w-0 max-w-full overflow-auto rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-2" style={{ maxHeight: "75vh" }} aria-busy={loading || rendering}>
        <canvas ref={canvas} className={`mx-auto block ${!page || loading || error ? "hidden" : ""}`} role="img" aria-label={`Última página del documento firmado del crédito ${folio}`}>
          Última página del documento firmado del crédito {folio}.
        </canvas>
      </div>
      {page?.text ? <p className="sr-only">Texto de la última página: {page.text}</p> : null}
    </div>
  );
}
