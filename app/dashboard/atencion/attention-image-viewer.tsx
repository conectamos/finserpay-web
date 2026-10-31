"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Download, Image as ImageIcon, RefreshCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
import styles from "./attention-image-viewer.module.css";

export default function AttentionImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      if (element.open) element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function toggleZoom() {
    if (zoom) setZoom(null);
    else if (loaded && image.current) setZoom({ width: image.current.clientWidth * 2, height: image.current.clientHeight * 2 });
  }

  return <dialog ref={dialog} className={styles.viewer} aria-label="Visor de imagen" aria-modal="true"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.layout}>
      <header className={styles.header}>
        <ImageIcon aria-hidden="true" size={22} />
        <h2 title={name}>{name}</h2>
        <div className={styles.actions}>
          <Button type="button" variant="ghost" disabled={!loaded || failed} aria-label={zoom ? "Ajustar imagen" : "Ampliar imagen"} title={zoom ? "Ajustar a la pantalla" : "Ampliar 2 veces"} onClick={toggleZoom}>{zoom ? <ZoomOut aria-hidden="true" size={22} /> : <ZoomIn aria-hidden="true" size={22} />}</Button>
          <a href={url} download={name} aria-label="Descargar imagen" title="Descargar imagen"><Download aria-hidden="true" size={22} /></a>
          <Button type="button" variant="ghost" aria-label="Cerrar visor de imagen" onClick={onClose}><X aria-hidden="true" size={24} /></Button>
        </div>
      </header>
      <div className={styles.stage} data-zoomed={Boolean(zoom)} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        {failed ? <div className={styles.feedback} role="alert"><ImageIcon aria-hidden="true" size={32} /><p>No se pudo cargar la imagen.</p><Button type="button" variant="secondary" onClick={() => { setFailed(false); setLoaded(false); setZoom(null); setAttempt(value => value + 1); }}><RefreshCw aria-hidden="true" size={18} />Reintentar imagen</Button></div> : <>
          {!loaded && <p className={styles.loading} role="status">Cargando imagen…</p>}
          <button type="button" className={styles.imageButton} aria-label={zoom ? "Ajustar imagen a la pantalla" : "Ampliar imagen 2 veces"} disabled={!loaded} onClick={event => { if (event.detail > 0 && event.target === event.currentTarget) onClose(); else toggleZoom(); }}>
            <Image ref={image} key={attempt} src={url} alt={name} width={1600} height={1200} unoptimized loading="eager" className={styles.image}
              style={zoom ? { width: zoom.width, height: zoom.height } : undefined}
              onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setFailed(true); }} />
          </button>
        </>}
      </div>
      <p className={styles.help}>{zoom ? "Desplázate para revisar la imagen ampliada." : "Toca la imagen para ampliarla. Pulsa Esc o cierra el visor para volver al chat."}</p>
    </div>
  </dialog>;
}
