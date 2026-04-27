"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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

const inputClass =
  "w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";

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
  const [items, setItems] = useState<EquipmentCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [precioBaseVenta, setPrecioBaseVenta] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const activeItems = useMemo(() => items.filter((item) => item.activo), [items]);
  const inactiveItems = useMemo(() => items.filter((item) => !item.activo), [items]);

  const loadSession = async () => {
    const result = await requestJson<SessionUser>("/api/session");

    if (result.ok) {
      setUser(result.data);
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
    const accepted = window.confirm(
      `Quitar ${item.marca} ${item.modelo} del catalogo de equipos?`
    );

    if (!accepted) {
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

  if (loading && !user) {
    return (
      <main className="min-h-screen bg-[#f4faf7] px-6 py-10 text-slate-900">
        <section className="mx-auto max-w-5xl rounded-[28px] border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold text-slate-500">Cargando catalogo...</p>
        </section>
      </main>
    );
  }

  if (!esAdmin) {
    return (
      <main className="min-h-screen bg-[#f4faf7] px-6 py-10 text-slate-900">
        <section className="mx-auto max-w-5xl rounded-[28px] border border-red-100 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-600">
            Acceso restringido
          </p>
          <h1 className="mt-3 text-3xl font-black">Catalogo de equipos</h1>
          <p className="mt-2 text-sm text-slate-600">
            Solo el administrador puede crear marcas, modelos y precios base.
          </p>
          <Link
            href="/dashboard"
            className="mt-6 inline-flex rounded-2xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700"
          >
            Volver al dashboard
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4faf7] px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl overflow-hidden rounded-[32px] border border-[#cfe5e2] bg-white shadow-[0_22px_60px_rgba(15,23,42,0.08)]">
        <div className="border-b border-[#dcebe8] bg-[linear-gradient(135deg,#ecfff8_0%,#ffffff_48%,#f7fbff_100%)] px-6 py-7 sm:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="inline-flex rounded-full border border-emerald-200 bg-white px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#0f5d59]">
                Administracion
              </p>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
                Catalogo de equipos
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Carga marcas, modelos y precio base. En la fabrica de creditos el asesor
                solo selecciona el equipo y el sistema calcula la inicial si hay excedente.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/dashboard"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/creditos"
                className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Fabrica de creditos
              </Link>
            </div>
          </div>
        </div>

        {notice && (
          <div
            className={[
              "mx-6 mt-6 rounded-2xl border px-4 py-3 text-sm font-semibold sm:mx-8",
              notice.tone === "emerald"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700",
            ].join(" ")}
          >
            {notice.text}
          </div>
        )}

        <div className="grid gap-6 px-6 py-6 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-[26px] border border-slate-200 bg-[#fbfefd] p-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0f5d59]">
              Modelo autorizado
            </p>
            <h2 className="mt-2 text-2xl font-black text-slate-950">
              {editingId ? "Actualizar equipo" : "Agregar equipo"}
            </h2>

            <div className="mt-5 grid gap-4">
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Marca
                </span>
                <input
                  value={marca}
                  onChange={(event) => setMarca(event.target.value)}
                  className={inputClass}
                  placeholder="Infinix, Samsung, Xiaomi"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Modelo
                </span>
                <input
                  value={modelo}
                  onChange={(event) => setModelo(event.target.value)}
                  className={inputClass}
                  placeholder="Hot 40, A05, Redmi 13C"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Precio base de venta
                </span>
                <input
                  value={currencyInputValue(precioBaseVenta)}
                  onChange={(event) =>
                    setPrecioBaseVenta(event.target.value.replace(/\D/g, ""))
                  }
                  inputMode="numeric"
                  className={inputClass}
                  placeholder="$ 800.000"
                />
              </label>

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void saveItem()}
                  disabled={saving}
                  className="rounded-2xl bg-[#0f5d59] px-5 py-3 text-sm font-bold text-white shadow-[0_14px_30px_rgba(15,93,89,0.22)] transition hover:bg-[#0b4744] disabled:opacity-70"
                >
                  {saving ? "Guardando..." : editingId ? "Actualizar modelo" : "Agregar modelo"}
                </button>
                {editingId && (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700"
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-[26px] border border-slate-200 bg-white p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
                  Lista activa
                </p>
                <h2 className="mt-2 text-2xl font-black text-slate-950">
                  {activeItems.length} modelos disponibles
                </h2>
              </div>
              <button
                type="button"
                onClick={() => void loadCatalog()}
                disabled={loading}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
              >
                {loading ? "Cargando..." : "Actualizar"}
              </button>
            </div>

            <div className="mt-5 grid gap-3">
              {activeItems.length ? (
                activeItems.map((item) => (
                  <div
                    key={item.id}
                    className="grid gap-3 rounded-[22px] border border-slate-200 bg-[#fbfefd] p-4 sm:grid-cols-[1fr_auto] sm:items-center"
                  >
                    <div>
                      <p className="text-base font-black text-slate-950">
                        {item.marca} {item.modelo}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-slate-500">
                        Precio base: {currency(item.precioBaseVenta)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => editItem(item)}
                        className="rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs font-bold text-[#0f5d59]"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteItem(item)}
                        disabled={saving}
                        className="rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 disabled:opacity-70"
                      >
                        Quitar
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-[22px] border border-dashed border-slate-300 bg-slate-50 p-6 text-sm font-semibold text-slate-500">
                  Aun no hay equipos cargados. Agrega el primer modelo para que aparezca
                  en el paso 2.
                </div>
              )}
            </div>

            {inactiveItems.length > 0 && (
              <p className="mt-4 text-xs font-semibold text-slate-400">
                {inactiveItems.length} modelos inactivos ocultos para asesores.
              </p>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
