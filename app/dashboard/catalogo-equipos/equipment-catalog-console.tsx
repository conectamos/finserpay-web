"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, CircleAlert, Pencil, Plus, RefreshCw, Search, Smartphone, Trash2, X } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import { Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, Select, StatusPill, Tabs } from "@/app/_components/finser-ui";
import { isEquipmentCatalogItemAllowedForPlatform } from "@/lib/credit-factory";
import type { EquipmentCatalogItem } from "@/lib/equipment-catalog";
import EquipmentVisual from "@/app/dashboard/creditos/equipment-visual";
import CatalogExportLink from "./catalog-export-link";
import styles from "./equipment-catalog-console.module.css";

type Product = "TODOS" | "ANDROID" | "IPHONE";
type CatalogStatus = "ACTIVOS" | "RETIRADOS" | "TODOS";
type CatalogResponse = { items?: EquipmentCatalogItem[]; error?: string };
const products = ["TODOS", "ANDROID", "IPHONE"] as const;
const currencyFormatter = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CO").replace(/\s+/g, " ").trim();
const matchesProduct = (item: EquipmentCatalogItem, product: Product) => product === "TODOS" || isEquipmentCatalogItemAllowedForPlatform(item, product);
const productLabel = (product: Product) => product === "TODOS" ? "Todos" : product === "IPHONE" ? "iPhone" : "Android";

async function requestCatalog(init?: RequestInit) {
  const response = await fetch(`/api/creditos/catalogo-equipos${!init?.method ? "?includeInactive=true" : ""}`, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({})) as CatalogResponse;
  if (!response.ok || !Array.isArray(data.items)) throw new Error(data.error || "No se pudo cargar el catálogo de equipos.");
  return data.items;
}

export default function EquipmentCatalogConsole() {
  const [items, setItems] = useState<EquipmentCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<Product>("TODOS");
  const [status, setStatus] = useState<CatalogStatus>("ACTIVOS");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [price, setPrice] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EquipmentCatalogItem | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const loadCatalog = useCallback(async () => {
    if (savingRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setNotice(null);
    try {
      const next = await requestCatalog({ signal: controller.signal });
      if (!controller.signal.aborted) setItems(next);
    } catch (cause) {
      if (!controller.signal.aborted) setNotice({ text: cause instanceof Error ? cause.message : "No se pudo cargar el catálogo.", error: true });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadCatalog();
    return () => { mountedRef.current = false; requestRef.current?.abort(); };
  }, [loadCatalog]);

  const openForm = (item?: EquipmentCatalogItem) => {
    if (savingRef.current) return;
    setEditingId(item?.id ?? null);
    setMarca(item?.marca ?? "");
    setModelo(item?.modelo ?? "");
    setPrice(item ? String(Math.round(item.precioBaseVenta)) : "");
    setFormError(null);
    setFormOpen(true);
  };
  const closeForm = () => { if (!savingRef.current) setFormOpen(false); };

  const saveItem = async () => {
    if (savingRef.current) return;
    if (!marca.trim() || !modelo.trim() || !price || Number(price) <= 0) {
      setFormError("Completa la marca, el modelo y un precio mayor a cero.");
      return;
    }
    savingRef.current = true;
    requestRef.current?.abort();
    setLoading(false);
    setSaving(true);
    setFormError(null);
    try {
      const next = await requestCatalog({
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, marca, modelo, precioBaseVenta: price }),
      });
      if (!mountedRef.current) return;
      setItems(next);
      setFormOpen(false);
      setNotice({ text: editingId ? "Equipo actualizado correctamente." : "Equipo agregado al catálogo.", error: false });
    } catch (cause) {
      if (mountedRef.current) setFormError(cause instanceof Error ? cause.message : "No se pudo guardar el equipo.");
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const deleteItem = async (item: EquipmentCatalogItem) => {
    if (savingRef.current) return;
    savingRef.current = true;
    requestRef.current?.abort();
    setLoading(false);
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/creditos/catalogo-equipos?id=${item.id}`, { method: "DELETE", cache: "no-store" });
      const data = await response.json().catch(() => ({})) as CatalogResponse;
      if (!response.ok || !Array.isArray(data.items)) throw new Error(data.error || "No se pudo retirar el equipo.");
      if (!mountedRef.current) return;
      setItems(data.items);
      setPendingDelete(null);
      setNotice({ text: "Equipo retirado del catálogo.", error: false });
    } catch (cause) {
      if (mountedRef.current) {
        setPendingDelete(null);
        setNotice({ text: cause instanceof Error ? cause.message : "No se pudo retirar el equipo.", error: true });
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const activeItems = items.filter(item => item.activo);
  const statusItems = items.filter(item => status === "TODOS" || (status === "ACTIVOS" ? item.activo : !item.activo));
  const filteredItems = statusItems.filter(item => matchesProduct(item, product) && normalized(`${item.marca} ${item.modelo}`).includes(normalized(query)));
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / 10));
  const currentPage = Math.min(page, pageCount);
  const rows = filteredItems.slice((currentPage - 1) * 10, currentPage * 10);
  const firstRow = filteredItems.length ? (currentPage - 1) * 10 + 1 : 0;

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <Link href="/dashboard" className={styles.back}><ArrowLeft size={16} aria-hidden="true" />Volver al panel central</Link>
        <PageHeader
          eyebrow="Administración"
          title="Catálogo de equipos"
          description="Modelos y precios base de venta."
          className={styles.heading}
          actions={<>
            <CatalogExportLink product={product} query={query} status={status} />
            <Button onClick={() => openForm()} disabled={saving}><Plus size={18} aria-hidden="true" />Nuevo equipo</Button>
          </>}
        />

        <div className={styles.summary} aria-label="Resumen del catálogo">
          <span><strong>{activeItems.length}</strong> {activeItems.length === 1 ? "modelo activo" : "modelos activos"}</span>
          <span><strong>{items.length - activeItems.length}</strong> {items.length - activeItems.length === 1 ? "retirado" : "retirados"}</span>
          <Link href="/dashboard/creditos">Fábrica de créditos<ArrowRight size={16} aria-hidden="true" /></Link>
        </div>

        {notice && <div className={`${styles.notice} ${notice.error ? styles.error : styles.success}`} role={notice.error ? "alert" : "status"}>
          {notice.error ? <CircleAlert size={20} aria-hidden="true" /> : <Check size={20} aria-hidden="true" />}
          <span>{notice.text}</span>
          {notice.error && <Button variant="secondary" onClick={() => void loadCatalog()} disabled={loading || saving}>Reintentar</Button>}
          <button type="button" onClick={() => setNotice(null)} aria-label="Cerrar mensaje"><X size={18} aria-hidden="true" /></button>
        </div>}

        <Card className={styles.catalog}>
          <div ref={tabsRef} className={styles.tabs}>
            <Tabs aria-label="Producto" onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = products.indexOf(product);
              const next = event.key === "Home" ? 0 : event.key === "End" ? products.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + products.length) % products.length;
              setProduct(products[next]); setPage(1);
              tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>
              {products.map(value => <button key={value} id={`central-catalog-tab-${value}`} type="button" role="tab" aria-selected={product === value}
                aria-controls="central-catalog-results" tabIndex={product === value ? 0 : -1} onClick={() => { setProduct(value); setPage(1); }}>
                {value === "TODOS" ? <Smartphone size={21} aria-hidden="true" /> : <EquipmentVisual reference="" platform={value === "IPHONE" ? "iphone" : "android"} className={styles.tabIcon} />}
                {productLabel(value)}<Badge>{statusItems.filter(item => matchesProduct(item, value)).length}</Badge>
              </button>)}
            </Tabs>
          </div>

          <div className={styles.toolbar}>
            <div className={styles.search}>
              <Search size={20} aria-hidden="true" />
              <Input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="Buscar marca o modelo" aria-label="Buscar equipos por marca o modelo" />
              {query && <button type="button" onClick={() => { setQuery(""); setPage(1); }} aria-label="Limpiar búsqueda"><X size={18} aria-hidden="true" /></button>}
            </div>
            <Select aria-label="Estado de los equipos" value={status} onChange={event => { setStatus(event.target.value as CatalogStatus); setPage(1); }}>
              <option value="ACTIVOS">Activos</option><option value="RETIRADOS">Retirados</option><option value="TODOS">Todos los estados</option>
            </Select>
            <Button variant="secondary" onClick={() => void loadCatalog()} disabled={loading || saving}>
              <RefreshCw size={18} className={loading ? "animate-spin" : undefined} aria-hidden="true" />{loading ? "Actualizando…" : "Actualizar"}
            </Button>
          </div>

          <div id="central-catalog-results" role="tabpanel" aria-labelledby={`central-catalog-tab-${product}`} aria-busy={loading}>
            {loading ? <div className={styles.empty}><LoadingState label="Cargando equipos…" /></div> : rows.length ? <>
              <div className={styles.tableHeading} aria-hidden="true"><span>Equipo / Marca</span><span>Producto</span><span>Precio base de venta</span><span>Estado</span><span>Acciones</span></div>
              <ul className={styles.list} aria-label="Equipos del catálogo">
                {rows.map(item => {
                  const platform = isEquipmentCatalogItemAllowedForPlatform(item, "IPHONE") ? "iphone" : "android";
                  return <li key={item.id} className={styles.row}>
                    <div className={styles.device}>
                      <EquipmentVisual reference={item.modelo} platform={platform} className={styles.deviceIcon} />
                      <div><h2>{item.modelo}</h2><span>{item.marca}</span></div>
                    </div>
                    <span className={styles.product}>{platform === "iphone" ? "iPhone" : "Android"}</span>
                    <div className={styles.price}><span>Precio base de venta</span><strong>{currencyFormatter.format(item.precioBaseVenta)}</strong></div>
                    <StatusPill tone={item.activo ? "positive" : "neutral"}>{item.activo ? "Activo" : "Retirado"}</StatusPill>
                    <div className={styles.rowActions}>
                      <Button variant="secondary" onClick={() => openForm(item)} disabled={saving} aria-label={`Editar ${item.marca} ${item.modelo}`}><Pencil size={17} aria-hidden="true" />Editar</Button>
                      <Button variant="ghost" onClick={() => setPendingDelete(item)} disabled={saving} aria-label={`Retirar ${item.marca} ${item.modelo}`} title="Retirar equipo"><Trash2 size={17} aria-hidden="true" /></Button>
                    </div>
                  </li>;
                })}
              </ul>
            </> : <div className={styles.empty}><EmptyState title={query ? "Sin coincidencias" : notice?.error ? "Catálogo no disponible" : "Sin equipos disponibles"}
              description={query ? "Prueba con otra marca o modelo." : undefined}
              action={query ? <Button variant="secondary" onClick={() => { setQuery(""); setPage(1); }}>Limpiar búsqueda</Button> : undefined} /></div>}
          </div>

          <footer className={styles.pagination}>
            <p role="status">Mostrando {firstRow}–{Math.min(currentPage * 10, filteredItems.length)} de {filteredItems.length} equipos</p>
            <nav aria-label="Páginas del catálogo">
              <Button variant="secondary" disabled={currentPage === 1 || loading} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} aria-hidden="true" />Anterior</Button>
              {Array.from({ length: pageCount }, (_, index) => index + 1).filter(value => value === 1 || value === pageCount || Math.abs(value - currentPage) <= 1).map((value, index, pages) => <span key={value}>
                {index > 0 && value - pages[index - 1] > 1 && <span className={styles.ellipsis}>…</span>}
                <button type="button" className={styles.page} aria-current={value === currentPage ? "page" : undefined} aria-label={`Página ${value}`} disabled={loading} onClick={() => setPage(value)}>{value}</button>
              </span>)}
              <Button variant="secondary" disabled={currentPage === pageCount || loading} onClick={() => setPage(currentPage + 1)}>Siguiente<ChevronRight size={17} aria-hidden="true" /></Button>
            </nav>
          </footer>
        </Card>
      </div>

      <FinserSidePanel open={formOpen} title={editingId ? "Editar equipo" : "Nuevo equipo"} busy={saving} onClose={closeForm} closeLabel="Cerrar formulario de equipo">
        <form className={styles.form} onSubmit={event => { event.preventDefault(); void saveItem(); }}>
          <span className={styles.formIcon}><Smartphone size={28} aria-hidden="true" /></span>
          <p>Define el modelo y su precio base de venta.</p>
          <label>Marca<Input value={marca} onChange={event => setMarca(event.target.value)} autoComplete="off" disabled={saving} required autoFocus placeholder="Ej. Samsung" /></label>
          <label>Modelo<Input value={modelo} onChange={event => setModelo(event.target.value)} autoComplete="off" disabled={saving} required placeholder="Ej. Galaxy A55 256GB" /></label>
          <label>Precio base de venta<Input value={price ? currencyFormatter.format(Number(price)) : ""} onChange={event => setPrice(event.target.value.replace(/\D/g, ""))} inputMode="numeric" disabled={saving} required placeholder="$ 0" /></label>
          {formError && <div role="alert" className={`${styles.notice} ${styles.error}`}><CircleAlert size={18} aria-hidden="true" /><span>{formError}</span></div>}
          <div className={styles.formActions}><Button variant="secondary" onClick={closeForm} disabled={saving}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Guardando…" : editingId ? "Guardar cambios" : "Guardar equipo"}</Button></div>
        </form>
      </FinserSidePanel>

      <ConfirmDialog open={Boolean(pendingDelete)} title="Retirar equipo del catálogo"
        description={pendingDelete ? `${pendingDelete.marca} ${pendingDelete.modelo} dejará de estar disponible para nuevas ventas.` : ""}
        confirmLabel="Retirar equipo" busy={saving} danger onCancel={() => { if (!savingRef.current) setPendingDelete(null); }}
        onConfirm={() => { if (pendingDelete) void deleteItem(pendingDelete); }} />
    </main>
  );
}
