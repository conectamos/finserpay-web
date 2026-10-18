"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, RefreshCw, Search, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, Tabs } from "@/app/_components/finser-ui";
import { isEquipmentCatalogItemAllowedForPlatform } from "@/lib/credit-factory";
import type { EquipmentCatalogItem } from "@/lib/equipment-catalog";
import EquipmentVisual from "@/app/dashboard/creditos/equipment-visual";
import CatalogExportLink from "./catalog-export-link";
import styles from "./ally-equipment-catalog.module.css";

type Product = "ANDROID" | "IPHONE";
type CatalogResponse = { items?: EquipmentCatalogItem[]; error?: string };
const products = ["ANDROID", "IPHONE"] as const;
const priceFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
});

function searchText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CO").replace(/\s+/g, " ").trim();
}

export default function AllyEquipmentCatalog() {
  const [items, setItems] = useState<EquipmentCatalogItem[]>([]);
  const [product, setProduct] = useState<Product>("ANDROID");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const loadCatalog = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/creditos/catalogo-equipos", {
        cache: "no-store", signal: controller.signal,
      });
      const data = await response.json() as CatalogResponse;
      if (!response.ok || !Array.isArray(data.items)) {
        throw new Error(data.error || "No se pudo cargar el catálogo de equipos.");
      }
      if (!controller.signal.aborted) setItems(data.items.filter(item => item.activo));
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "No se pudo cargar el catálogo de equipos.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    return () => requestRef.current?.abort();
  }, [loadCatalog]);

  const productItems = items.filter(item => isEquipmentCatalogItemAllowedForPlatform(item, product));
  const needle = searchText(query);
  const visibleItems = productItems.filter(item => searchText(`${item.marca} ${item.modelo}`).includes(needle));

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <Link href="/dashboard" className={styles.back}>
          <ArrowLeft size={16} aria-hidden="true" /> Volver al panel aliado
        </Link>
        <PageHeader
          eyebrow="Equipos y precios"
          title="Catálogo de equipos"
          description="Consulta los equipos disponibles y su precio base de venta."
          actions={
            <>
              <CatalogExportLink product={product} query={query} />
              <Button variant="secondary" onClick={() => void loadCatalog()} disabled={loading}>
                <RefreshCw size={17} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
                {loading ? "Actualizando…" : "Actualizar"}
              </Button>
            </>
          }
        />

        <Card className={styles.catalog}>
          <div className={styles.toolbar}>
            <div ref={tabsRef} className={styles.productTabs}>
              <Tabs aria-label="Producto" onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : product === "ANDROID" ? 1 : 0;
                setProduct(products[next]);
                tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              }}>
                {products.map(value => (
                  <button
                    type="button"
                    key={value}
                    id={`catalog-tab-${value}`}
                    role="tab"
                    aria-selected={product === value}
                    aria-controls="catalog-products"
                    tabIndex={product === value ? 0 : -1}
                    onClick={() => setProduct(value)}
                  >
                    <EquipmentVisual reference="" platform={value === "IPHONE" ? "iphone" : "android"} className={styles.tabIcon} />
                    {value}
                    {!loading && <Badge>{items.filter(item => isEquipmentCatalogItemAllowedForPlatform(item, value)).length}</Badge>}
                  </button>
                ))}
              </Tabs>
            </div>
            <div className={styles.search}>
              <Search size={19} aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Buscar marca o modelo"
                aria-label="Buscar equipos por marca o modelo"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Limpiar búsqueda"><X size={17} aria-hidden="true" /></button>}
            </div>
          </div>

          <div id="catalog-products" role="tabpanel" aria-labelledby={`catalog-tab-${product}`} aria-busy={loading} tabIndex={0} className={styles.results}>
            {error && <div className={styles.error} role="alert">
              <CircleAlert size={20} aria-hidden="true" />
              <span>{error}</span>
              <Button variant="secondary" onClick={() => void loadCatalog()} disabled={loading}>Reintentar</Button>
            </div>}
            {loading ? <LoadingState label="Cargando equipos y precios…" /> : !visibleItems.length ? (
              <EmptyState
                title={error ? "Catálogo no disponible" : query ? "Sin coincidencias" : "Sin equipos disponibles"}
                description={error ? undefined : query ? "Prueba con otra marca o modelo." : `No hay equipos activos en ${product === "IPHONE" ? "iPhone" : "Android"}.`}
                action={query ? <Button variant="secondary" onClick={() => setQuery("")}>Limpiar búsqueda</Button> : undefined}
              />
            ) : <>
              <p className={styles.count} role="status">{visibleItems.length} de {productItems.length} equipos {product === "IPHONE" ? "iPhone" : "Android"}</p>
              <ul className={styles.grid} aria-label={`Equipos ${product === "IPHONE" ? "iPhone" : "Android"}`}>
                {visibleItems.map(item => (
                  <li key={item.id} className={styles.equipment}>
                    <div className={styles.identity}>
                      <EquipmentVisual reference={item.modelo} platform={product === "IPHONE" ? "iphone" : "android"} className={styles.deviceIcon} />
                      <div>
                        <span className={styles.brand}>{item.marca}</span>
                        <h2>{item.modelo}</h2>
                      </div>
                    </div>
                    <div className={styles.price}>
                      <span>Precio base de venta</span>
                      <strong>{priceFormatter.format(item.precioBaseVenta)}</strong>
                    </div>
                  </li>
                ))}
              </ul>
            </>}
          </div>
        </Card>
      </div>
    </main>
  );
}
