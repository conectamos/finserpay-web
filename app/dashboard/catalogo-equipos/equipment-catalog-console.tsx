"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  PageHeader,
  StatusPill,
} from "@/app/_components/finser-ui";

type SessionUser = {
  rolNombre: string;
};

type EquipmentCatalogItem = {
  id: number;
  marca: string;
  modelo: string;
  precioBaseVenta: number;
  activo: boolean;
};

type EquipmentCatalogResponse = {
  ok?: boolean;
  items?: EquipmentCatalogItem[];
  error?: string;
};

const currencyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function currency(value: number) {
  return currencyFormatter.format(Math.round(Number(value || 0)));
}

function currencyInputValue(value: string | number) {
  const normalized = String(value ?? "").replace(/\D/g, "");

  if (!normalized) {
    return "";
  }

  return currencyFormatter.format(Number(normalized));
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });

  const data = (await response.json().catch(() => ({}))) as T;

  return { ok: response.ok, data };
}

export default function EquipmentCatalogConsole() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [items, setItems] = useState<EquipmentCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EquipmentCatalogItem | null>(null);
  const [query, setQuery] = useState("");
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [precioBaseVenta, setPrecioBaseVenta] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const activeItems = useMemo(() => items.filter((item) => item.activo), [items]);
  const inactiveItems = useMemo(() => items.filter((item) => !item.activo), [items]);
  const filteredActiveItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es-CO");

    if (!needle) {
      return activeItems;
    }

    return activeItems.filter((item) =>
      `${item.marca} ${item.modelo}`.toLocaleLowerCase("es-CO").includes(needle)
    );
  }, [activeItems, query]);

  const loadSession = async () => {
    try {
      const result = await requestJson<SessionUser>("/api/session");

      if (result.ok) {
        setUser(result.data);
      }
    } finally {
      setSessionReady(true);
    }
  };

  const loadCatalog = async () => {
    try {
      setLoading(true);
      const result = await requestJson<EquipmentCatalogResponse>(
        "/api/creditos/catalogo-equipos?includeInactive=true"
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo cargar el catalogo");
      }

      setItems(result.data.items || []);
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo cargar el catalogo",
        tone: "red",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSession();
    void loadCatalog();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setMarca("");
    setModelo("");
    setPrecioBaseVenta("");
  };

  const editItem = (item: EquipmentCatalogItem) => {
    setEditingId(item.id);
    setMarca(item.marca);
    setModelo(item.modelo);
    setPrecioBaseVenta(String(Math.round(item.precioBaseVenta)));
    setNotice(null);
  };

  const saveItem = async () => {
    if (saving) {
      return;
    }

    try {
      setSaving(true);
      setNotice(null);

      const result = await requestJson<EquipmentCatalogResponse>(
        "/api/creditos/catalogo-equipos",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editingId,
            marca,
            modelo,
            precioBaseVenta,
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo guardar el modelo");
      }

      setItems(result.data.items || []);
      setNotice({
        text: editingId ? "Modelo actualizado correctamente" : "Modelo agregado al catalogo",
        tone: "emerald",
      });
      resetForm();
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo guardar el modelo",
        tone: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async (item: EquipmentCatalogItem) => {
    if (saving) {
      return;
    }

    try {
      setSaving(true);
      setNotice(null);

      const result = await requestJson<EquipmentCatalogResponse>(
        `/api/creditos/catalogo-equipos?id=${item.id}`,
        { method: "DELETE" }
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo quitar el modelo");
      }

      setItems(result.data.items || []);
      setNotice({ text: "Modelo retirado del catalogo", tone: "emerald" });
      setPendingDelete(null);

      if (editingId === item.id) {
        resetForm();
      }
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo quitar el modelo",
        tone: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!sessionReady || (loading && !items.length)) {
    return (
      <main className="min-h-[calc(100dvh-64px)] bg-[var(--fp-bg)] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1480px]">
          <LoadingState label="Cargando catalogo de equipos..." />
        </div>
      </main>
    );
  }

  if (!esAdmin) {
    return (
      <main className="min-h-[calc(100dvh-64px)] bg-[var(--fp-bg)] px-4 py-6 sm:px-6 lg:px-8">
        <Card className="mx-auto max-w-3xl p-6 sm:p-8">
          <EmptyState
            title="Acceso restringido"
            description="Solo el administrador puede crear marcas, modelos y precios base."
            action={
              <Link href="/dashboard" className="fp-ui-button is-secondary mt-5">
                Volver al panel
              </Link>
            }
          />
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--fp-bg)] px-4 py-6 text-[var(--fp-graphite)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1480px]">
        <PageHeader
          eyebrow="Administracion"
          title="Catalogo de equipos"
          description="Gestiona los modelos y precios que usa la fabrica de creditos."
          actions={
            <Link href="/dashboard/creditos" className="fp-ui-button is-secondary">
              Fabrica de creditos
              <ArrowRight className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
            </Link>
          }
        />

        <section
          className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-[var(--fp-border)] py-4"
          aria-label="Resumen del catalogo"
        >
          <div>
            <strong className="block text-2xl font-black leading-none text-[var(--fp-graphite)]">
              {activeItems.length}
            </strong>
            <span className="mt-1 block text-xs font-semibold text-[var(--fp-muted)]">
              Modelos activos
            </span>
          </div>
          <span className="h-9 w-px bg-[var(--fp-border)]" aria-hidden="true" />
          <div>
            <strong className="block text-2xl font-black leading-none text-[var(--fp-graphite)]">
              {inactiveItems.length}
            </strong>
            <span className="mt-1 block text-xs font-semibold text-[var(--fp-muted)]">
              Retirados
            </span>
          </div>
          <span className="hidden h-9 w-px bg-[var(--fp-border)] sm:block" aria-hidden="true" />
          <p className="w-full text-sm text-[var(--fp-muted)] sm:w-auto">
            Los cambios se reflejan en la seleccion de equipos de nuevas ventas.
          </p>
        </section>

        {notice ? (
          <div
            className={[
              "mt-5 flex items-start gap-3 border px-4 py-3 text-sm font-semibold",
              notice.tone === "emerald"
                ? "border-[#c9dda2] bg-[var(--fp-lime-soft)] text-[#365314]"
                : "border-[#f2b8b5] bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]",
            ].join(" ")}
            role="status"
            aria-live="polite"
          >
            {notice.tone === "emerald" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            ) : (
              <CircleAlert
                className="mt-0.5 h-4 w-4 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
            )}
            <span>{notice.text}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="ml-auto grid h-8 w-8 shrink-0 place-items-center"
              aria-label="Cerrar mensaje"
            >
              <X className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div className="mt-6 grid items-start gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="overflow-hidden xl:sticky xl:top-6">
            <div className="border-b border-[var(--fp-border)] p-5 sm:p-6">
              <StatusPill tone={editingId ? "warning" : "positive"}>
                {editingId ? "Editando modelo" : "Nuevo modelo"}
              </StatusPill>
              <h2 className="mt-3 text-xl font-black">
                {editingId ? "Actualizar equipo" : "Agregar equipo"}
              </h2>
              <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                Define la referencia y su precio base de venta.
              </p>
            </div>

            <form
              className="grid gap-4 p-5 sm:p-6"
              onSubmit={(event) => {
                event.preventDefault();
                void saveItem();
              }}
            >
              <label className="block">
                <span className="mb-2 block text-sm font-bold">Marca</span>
                <Input
                  value={marca}
                  onChange={(event) => setMarca(event.target.value)}
                  placeholder="Ej. Infinix"
                  autoComplete="off"
                  disabled={saving}
                  required
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-bold">Modelo</span>
                <Input
                  value={modelo}
                  onChange={(event) => setModelo(event.target.value)}
                  placeholder="Ej. Hot 40 256GB"
                  autoComplete="off"
                  disabled={saving}
                  required
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-bold">Precio base de venta</span>
                <Input
                  value={currencyInputValue(precioBaseVenta)}
                  onChange={(event) =>
                    setPrecioBaseVenta(event.target.value.replace(/\D/g, ""))
                  }
                  inputMode="numeric"
                  placeholder="$ 0"
                  disabled={saving}
                  required
                />
              </label>

              <div className="mt-1 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <Button type="submit" disabled={saving}>
                  {editingId ? (
                    <Check className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  )}
                  {saving
                    ? "Guardando..."
                    : editingId
                      ? "Guardar cambios"
                      : "Agregar modelo"}
                </Button>
                {editingId ? (
                  <Button variant="secondary" onClick={resetForm} disabled={saving}>
                    Cancelar edicion
                  </Button>
                ) : null}
              </div>
            </form>
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <div className="flex flex-col gap-4 border-b border-[var(--fp-border)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div>
                <p className="fp-ui-eyebrow">Lista activa</p>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-black">Modelos disponibles</h2>
                  <StatusPill tone="positive">{activeItems.length} activos</StatusPill>
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => void loadCatalog()}
                disabled={loading}
                className="shrink-0"
                aria-label="Actualizar catalogo"
              >
                <RefreshCw
                  className={["h-4 w-4", loading && "animate-spin"].filter(Boolean).join(" ")}
                  strokeWidth={1.9}
                  aria-hidden="true"
                />
                Actualizar
              </Button>
            </div>

            <div className="border-b border-[var(--fp-border)] p-4 sm:p-5">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[#98a2b3]"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-10 pr-11"
                  placeholder="Buscar por marca o modelo"
                  aria-label="Buscar equipos por marca o modelo"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center text-[var(--fp-muted)]"
                    aria-label="Limpiar busqueda"
                  >
                    <X className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <p className="mt-2 text-xs font-semibold text-[var(--fp-muted)]">
                {query
                  ? `${filteredActiveItems.length} coincidencias`
                  : "Ordenado segun el catalogo vigente"}
              </p>
            </div>

            {loading ? (
              <div className="p-5">
                <LoadingState label="Actualizando modelos..." />
              </div>
            ) : filteredActiveItems.length ? (
              <div>
                <div className="hidden grid-cols-[minmax(0,1fr)_180px_112px] gap-4 bg-[#f7f8f7] px-5 py-3 text-[11px] font-extrabold uppercase text-[var(--fp-muted)] md:grid">
                  <span>Equipo</span>
                  <span className="text-right">Precio base</span>
                  <span className="text-right">Acciones</span>
                </div>
                <ul aria-label="Modelos activos">
                  {filteredActiveItems.map((item) => {
                    const editing = editingId === item.id;

                    return (
                      <li
                        key={item.id}
                        className={[
                          "grid gap-3 border-t border-[var(--fp-border)] px-4 py-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_180px_112px] md:items-center md:gap-4 md:px-5",
                          editing && "bg-[var(--fp-lime-soft)]",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            className={[
                              "grid h-10 w-10 shrink-0 place-items-center border",
                              editing
                                ? "border-[#9cc72e] bg-white text-[#55710b]"
                                : "border-[var(--fp-border)] bg-[#f7f8f7] text-[var(--fp-muted)]",
                            ].join(" ")}
                            aria-hidden="true"
                          >
                            <Smartphone className="h-5 w-5" strokeWidth={1.8} />
                          </span>
                          <div className="min-w-0">
                            <strong className="block truncate text-sm font-black">
                              {item.modelo}
                            </strong>
                            <span className="mt-1 block truncate text-xs font-semibold uppercase text-[var(--fp-muted)]">
                              {item.marca}
                            </span>
                          </div>
                        </div>

                        <div className="pl-[52px] md:pl-0 md:text-right">
                          <span className="block text-[11px] font-semibold text-[var(--fp-muted)] md:hidden">
                            Precio base
                          </span>
                          <strong className="text-sm tabular-nums">
                            {currency(item.precioBaseVenta)}
                          </strong>
                        </div>

                        <div className="flex justify-end gap-2 pl-[52px] md:pl-0">
                          <Button
                            variant="secondary"
                            onClick={() => editItem(item)}
                            disabled={saving}
                            className="h-11 w-11 p-0"
                            aria-label={`Editar ${item.marca} ${item.modelo}`}
                            title="Editar modelo"
                          >
                            <Pencil className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setPendingDelete(item)}
                            disabled={saving}
                            className="h-11 w-11 border border-[#f0c7c5] p-0 text-[var(--fp-danger)]"
                            aria-label={`Retirar ${item.marca} ${item.modelo}`}
                            title="Retirar modelo"
                          >
                            <Trash2 className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <div className="p-6">
                <EmptyState
                  title={query ? "No encontramos coincidencias" : "Aun no hay modelos activos"}
                  description={
                    query
                      ? "Prueba con otra marca o referencia."
                      : "Agrega el primer modelo para habilitarlo en nuevas ventas."
                  }
                />
              </div>
            )}

            {inactiveItems.length ? (
              <div className="border-t border-[var(--fp-border)] bg-[#f7f8f7] px-5 py-3 text-xs font-semibold text-[var(--fp-muted)]">
                {inactiveItems.length} modelos retirados no se muestran a los asesores.
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Retirar modelo del catalogo"
        description={
          pendingDelete
            ? `${pendingDelete.marca} ${pendingDelete.modelo} dejara de estar disponible para nuevas ventas.`
            : ""
        }
        confirmLabel="Retirar modelo"
        busy={saving}
        danger
        onCancel={() => {
          if (!saving) {
            setPendingDelete(null);
          }
        }}
        onConfirm={() => {
          if (pendingDelete) {
            void deleteItem(pendingDelete);
          }
        }}
      />
    </main>
  );
}
