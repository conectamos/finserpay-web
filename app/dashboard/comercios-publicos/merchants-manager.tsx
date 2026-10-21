"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, Eye, EyeOff, ImagePlus, Pencil, Plus } from "lucide-react";
import { Button, Card, Input, PageHeader } from "@/app/_components/finser-ui";
import styles from "./merchants-manager.module.css";

type Merchant = { id: string; nombre: string; direccion: string; telefono: string; imagen: string; publicado: boolean };
const empty = { nombre: "", direccion: "", telefono: "", imagen: "", publicado: true };

export default function MerchantsManager() {
  const [items, setItems] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const [editing, setEditing] = useState<Merchant | null>(null);
  const [form, setForm] = useState(empty);
  const fileInput = useRef<HTMLInputElement>(null);
  const formCard = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoadError("");
    try {
      const response = await fetch("/api/admin/comercios-publicos", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No pudimos cargar los comercios.");
      setItems(data.comercios);
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "No pudimos cargar los comercios."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  function reset() {
    setEditing(null); setForm(empty); setError("");
    if (fileInput.current) fileInput.current.value = "";
  }

  function edit(item: Merchant) {
    setEditing(item); setForm({ nombre: item.nombre, direccion: item.direccion, telefono: item.telefono, imagen: "", publicado: item.publicado });
    setError(""); setMessage("");
    if (fileInput.current) fileInput.current.value = "";
    formCard.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    formCard.current?.querySelector<HTMLInputElement>('input[name="nombre"]')?.focus({ preventScroll: true });
  }

  async function readImage(file?: File) {
    if (!file) return;
    setError("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setError("Selecciona una foto JPG, PNG o WebP de máximo 2 MB.");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setReadingImage(true);
    try {
      const imagen = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("No pudimos leer la imagen."));
        reader.readAsDataURL(file);
      });
      setForm((previous) => ({ ...previous, imagen }));
    } catch { setError("No pudimos leer la imagen. Selecciónala de nuevo."); }
    finally { setReadingImage(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || readingImage) return;
    if (!editing && !form.imagen) { setError("Selecciona la imagen del comercio."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/comercios-publicos", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, ...(editing ? { id: editing.id } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "No pudimos guardar el comercio.");
      setMessage(form.publicado ? "Comercio guardado y publicado en ¿Dónde comprar?." : "Comercio guardado. Está oculto en la página pública.");
      reset(); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No pudimos guardar el comercio."); }
    finally { setBusy(false); }
  }

  async function toggle(item: Merchant) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/comercios-publicos", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, publicado: !item.publicado }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "No pudimos cambiar la visibilidad.");
      if (editing?.id === item.id) setForm((previous) => ({ ...previous, publicado: !item.publicado }));
      setMessage(item.publicado ? "Comercio oculto en la página pública." : "Comercio publicado en ¿Dónde comprar?.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No pudimos cambiar la visibilidad."); }
    finally { setBusy(false); }
  }

  const preview = form.imagen || editing?.imagen;
  return <div className={styles.workspace}>
    <PageHeader eyebrow="PÁGINA WEB" title="¿Dónde comprar?" description="Agrega los comercios que quieres mostrar a tus clientes." actions={<Link className={styles.publicLink} href="/#donde-comprar" target="_blank" rel="noopener noreferrer">Ver página pública <ArrowUpRight size={18} aria-hidden="true" /></Link>} />
    {message && <p role="status" className={styles.success}>{message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.columns}>
      <div ref={formCard} className={styles.formAnchor}><Card><h2 className={styles.title}>{editing ? "Editar comercio" : "Agregar comercio"}</h2>
        <form onSubmit={save} className={styles.form}>
          <fieldset disabled={busy || readingImage} className={styles.fields}>
            <label>Nombre<Input name="nombre" value={form.nombre} onChange={(event) => setForm({ ...form, nombre: event.target.value })} required minLength={2} maxLength={120} placeholder="Nombre del comercio" /></label>
            <label>Imagen<Input ref={fileInput} name="imagen" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void readImage(event.target.files?.[0])} required={!editing && !form.imagen} /><small>JPG, PNG o WebP · máximo 2 MB</small></label>
            {preview ? <img className={styles.preview} src={preview} alt="Vista previa de la imagen del comercio" width={600} height={400} /> : <div className={styles.imagePlaceholder}><ImagePlus size={30} aria-hidden="true" /><span>Selecciona una imagen del comercio</span></div>}
            <label>Dirección<Input name="direccion" value={form.direccion} onChange={(event) => setForm({ ...form, direccion: event.target.value })} required minLength={5} maxLength={240} placeholder="Dirección completa, incluida la ciudad" /></label>
            <label>Teléfono<Input name="telefono" type="tel" value={form.telefono} onChange={(event) => setForm({ ...form, telefono: event.target.value })} required maxLength={24} placeholder="Celular o teléfono con indicativo" /></label>
            <label className={styles.checkbox}><input type="checkbox" checked={form.publicado} onChange={(event) => setForm({ ...form, publicado: event.target.checked })} />Mostrar en ¿Dónde comprar?</label>
          </fieldset>
          <div className={styles.actions}><Button type="submit" disabled={busy || readingImage}>{busy ? "Guardando…" : readingImage ? "Leyendo imagen…" : editing ? "Guardar cambios" : <><Plus size={17} aria-hidden="true" />Agregar comercio</>}</Button>{editing && <Button variant="secondary" onClick={reset} disabled={busy || readingImage}>Cancelar</Button>}</div>
        </form>
      </Card></div>
      <section aria-label="Comercios registrados"><div className={styles.listHeading}><h2 className={styles.title}>Tus comercios</h2><span>{items.length}</span></div>
        {loading && <p role="status">Cargando comercios…</p>}
        {loadError && <div className={styles.error} role="alert"><p>{loadError}</p><Button variant="secondary" onClick={() => void refresh()}>Reintentar</Button></div>}
        {!loading && !loadError && !items.length && <Card><p>Aún no has agregado comercios. Crea el primero con el formulario.</p></Card>}
        <div className={styles.list}>{items.map((item) => <Card key={item.id} className={styles.merchant}>
          <img src={item.imagen} alt={item.nombre} width={180} height={120} className={styles.thumbnail} loading="lazy" />
          <div className={styles.details}><span className={item.publicado ? styles.published : styles.hidden}>{item.publicado ? "Publicado" : "Oculto"}</span><h3>{item.nombre}</h3><p>{item.direccion}</p><p>+{item.telefono}</p><div className={styles.actions}><Button variant="secondary" disabled={busy || readingImage} onClick={() => edit(item)} aria-label={`Editar ${item.nombre}`}><Pencil size={15} aria-hidden="true" />Editar</Button><Button variant="ghost" disabled={busy} onClick={() => void toggle(item)} aria-label={`${item.publicado ? "Ocultar" : "Publicar"} ${item.nombre}`}>{item.publicado ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}{item.publicado ? "Ocultar" : "Publicar"}</Button></div></div>
        </Card>)}</div>
      </section>
    </div>
  </div>;
}
