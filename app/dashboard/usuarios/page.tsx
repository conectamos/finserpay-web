"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

type SedeItem = {
  id: number;
  nombre: string;
  activa: boolean;
};

type SellerItem = {
  id: number;
  nombre: string;
  tipoPerfil: "VENDEDOR" | "SUPERVISOR";
  documento: string | null;
  telefono: string | null;
  email: string | null;
  activo: boolean;
  debeCambiarPin: boolean;
  assignedSedeIds: number[];
  assignedSedes: Array<{
    id: number;
    nombre: string;
  }>;
  createdAt: string;
  updatedAt: string;
  ultimoIngresoAt: string | null;
};

type AdminItem = {
  id: number;
  nombre: string;
  usuario: string;
  activo: boolean;
  rolNombre: string;
  sede: {
    id: number;
    nombre: string;
  };
  createdAt: string;
  updatedAt: string;
};

type AdminUsersResponse = {
  ok: boolean;
  mensaje?: string;
  sedes: SedeItem[];
  vendedores: SellerItem[];
  administradores: AdminItem[];
};

type SellerDraft = {
  nombre: string;
  documento: string;
  telefono: string;
  email: string;
  pin: string;
  activo: boolean;
  sedeIds: number[];
};

type SelectedProfile =
  | { type: "SUPERVISOR" | "VENDEDOR"; id: number }
  | { type: "ADMIN"; id: number }
  | null;

function formatDate(value: string | null) {
  if (!value) {
    return "Nunca";
  }

  try {
    return new Date(value).toLocaleString("es-CO");
  } catch {
    return value;
  }
}

function sanitizeDocument(value: string) {
  return value.replace(/\D/g, "");
}

function sanitizePin(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

function sanitizePhone(value: string) {
  return value.replace(/[^\d+]/g, "");
}

function SedeTransferBoard({
  sedes,
  selectedIds,
  onToggle,
}: {
  sedes: SedeItem[];
  selectedIds: number[];
  onToggle: (sedeId: number) => void;
}) {
  const selected = sedes.filter((sede) => selectedIds.includes(sede.id));
  const available = sedes.filter((sede) => !selectedIds.includes(sede.id));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="rounded-[28px] border border-slate-300 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-slate-700">Sedes disponibles</p>
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
          {available.length ? (
            available.map((sede) => (
              <label
                key={sede.id}
                className="flex cursor-pointer items-center gap-3 rounded-2xl bg-[#eef9fb] px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-[#e4f4f8]"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(sede.id)}
                  onChange={() => onToggle(sede.id)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>{sede.nombre}</span>
              </label>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
              Todas las sedes ya quedaron asignadas.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-300 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-slate-700">Sedes asignadas</p>
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
          {selected.length ? (
            selected.map((sede) => (
              <label
                key={sede.id}
                className="flex cursor-pointer items-center gap-3 rounded-2xl bg-[#eef9fb] px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-[#e4f4f8]"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(sede.id)}
                  onChange={() => onToggle(sede.id)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>{sede.nombre}</span>
              </label>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
              Selecciona una o varias sedes para este vendedor.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ProfileColumn({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-black text-slate-950">{title}</h3>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-bold text-slate-600">
          {count}
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {count ? (
          children
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-500">
            {empty}
          </div>
        )}
      </div>
    </section>
  );
}

function SellerProfileButton({
  seller,
  selected,
  onClick,
}: {
  seller: SellerItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full rounded-2xl border px-4 py-4 text-left transition",
        selected
          ? "border-slate-950 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.10)]"
          : "border-slate-200 bg-white hover:border-slate-400",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-black text-slate-950">{seller.nombre}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            {seller.documento || "Sin documento"}
          </p>
        </div>
        <span
          className={[
            "rounded-full px-2.5 py-1 text-[11px] font-bold",
            seller.activo
              ? "bg-emerald-50 text-emerald-700"
              : "bg-slate-100 text-slate-500",
          ].join(" ")}
        >
          {seller.activo ? "Activo" : "Inactivo"}
        </span>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">
        {seller.assignedSedes.length
          ? seller.assignedSedes.map((sede) => sede.nombre).join(", ")
          : "Sin sedes asignadas"}
      </p>
    </button>
  );
}

function AdminProfileButton({
  admin,
  selected,
  onClick,
}: {
  admin: AdminItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full rounded-2xl border px-4 py-4 text-left transition",
        selected
          ? "border-slate-950 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.10)]"
          : "border-slate-200 bg-white hover:border-slate-400",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-black text-slate-950">{admin.nombre}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            Usuario: {admin.usuario}
          </p>
        </div>
        <span
          className={[
            "rounded-full px-2.5 py-1 text-[11px] font-bold",
            admin.activo
              ? "bg-emerald-50 text-emerald-700"
              : "bg-slate-100 text-slate-500",
          ].join(" ")}
        >
          {admin.activo ? "Activo" : "Inactivo"}
        </span>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">
        Sede base: {admin.sede.nombre}
      </p>
    </button>
  );
}

export default function GestionVendedoresPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<SedeItem[]>([]);
  const [vendedores, setVendedores] = useState<SellerItem[]>([]);
  const [administradores, setAdministradores] = useState<AdminItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardandoNuevo, setGuardandoNuevo] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);
  const [filtroSede, setFiltroSede] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<SelectedProfile>(null);

  const [nuevo, setNuevo] = useState<SellerDraft>({
    nombre: "",
    documento: "",
    telefono: "",
    email: "",
    pin: "",
    activo: true,
    sedeIds: [],
  });

  const [ediciones, setEdiciones] = useState<Record<number, SellerDraft>>({});

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const applyData = (data: AdminUsersResponse) => {
    const sellers = Array.isArray(data.vendedores) ? data.vendedores : [];
    const sedeItems = Array.isArray(data.sedes) ? data.sedes : [];
    const adminItems = Array.isArray(data.administradores)
      ? data.administradores
      : [];

    setSedes(sedeItems);
    setVendedores(sellers);
    setAdministradores(adminItems);
    setEdiciones(
      sellers.reduce(
        (acc, item) => {
          acc[item.id] = {
            nombre: item.nombre,
            documento: item.documento || "",
            telefono: item.telefono || "",
            email: item.email || "",
            pin: "",
            activo: item.activo,
            sedeIds: item.assignedSedeIds,
          };
          return acc;
        },
        {} as Record<number, SellerDraft>
      )
    );
  };

  const cargarTodo = async () => {
    try {
      const [sessionRes, usersRes] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }),
        fetch("/api/usuarios/admin", { cache: "no-store" }),
      ]);

      const sessionData = await sessionRes.json();
      const usersData = (await usersRes.json()) as AdminUsersResponse & {
        error?: string;
      };

      if (sessionRes.ok) {
        setUser(sessionData);
      }

      if (usersRes.ok) {
        applyData(usersData);
      } else {
        setMensaje(usersData.error || "No se pudo cargar la gestion de vendedores");
      }
    } catch {
      setMensaje("Error cargando la gestion de vendedores");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargarTodo();
  }, []);

  const vendedoresFiltrados = useMemo(() => {
    if (!filtroSede) {
      return vendedores;
    }

    const sedeId = Number(filtroSede || 0);
    return vendedores.filter((item) => item.assignedSedeIds.includes(sedeId));
  }, [filtroSede, vendedores]);
  const supervisoresFiltrados = useMemo(
    () => vendedoresFiltrados.filter((item) => item.tipoPerfil === "SUPERVISOR"),
    [vendedoresFiltrados]
  );
  const vendedoresOperativosFiltrados = useMemo(
    () => vendedoresFiltrados.filter((item) => item.tipoPerfil === "VENDEDOR"),
    [vendedoresFiltrados]
  );
  const selectedSeller =
    selectedProfile?.type === "SUPERVISOR" || selectedProfile?.type === "VENDEDOR"
      ? vendedores.find((item) => item.id === selectedProfile.id) || null
      : null;
  const selectedAdmin =
    selectedProfile?.type === "ADMIN"
      ? administradores.find((item) => item.id === selectedProfile.id) || null
      : null;

  const toggleNuevoSede = (sedeId: number) => {
    setNuevo((current) => ({
      ...current,
      sedeIds: current.sedeIds.includes(sedeId)
        ? current.sedeIds.filter((item) => item !== sedeId)
        : [...current.sedeIds, sedeId],
    }));
  };

  const toggleEdicionSede = (vendedorId: number, sedeId: number) => {
    setEdiciones((current) => {
      const draft = current[vendedorId];
      const sedeIds = draft.sedeIds.includes(sedeId)
        ? draft.sedeIds.filter((item) => item !== sedeId)
        : [...draft.sedeIds, sedeId];

      return {
        ...current,
        [vendedorId]: {
          ...draft,
          sedeIds,
        },
      };
    });
  };

  const actualizarNuevo = (campo: keyof SellerDraft, valor: string | boolean | number[]) => {
    setNuevo((current) => ({
      ...current,
      [campo]: valor,
    }));
  };

  const actualizarEdicion = (
    vendedorId: number,
    campo: keyof SellerDraft,
    valor: string | boolean | number[]
  ) => {
    setEdiciones((current) => ({
      ...current,
      [vendedorId]: {
        ...current[vendedorId],
        [campo]: valor,
      },
    }));
  };

  const crearVendedor = async () => {
    try {
      setGuardandoNuevo(true);
      setMensaje("");

      const res = await fetch("/api/usuarios/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nombre: nuevo.nombre,
          documento: nuevo.documento,
          telefono: nuevo.telefono,
          email: nuevo.email,
          pin: nuevo.pin,
          activo: nuevo.activo,
          sedeIds: nuevo.sedeIds,
        }),
      });

      const data = (await res.json()) as AdminUsersResponse & {
        error?: string;
        mensaje?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear el vendedor");
        return;
      }

      applyData(data);
      setMensaje(data.mensaje || "Vendedor creado correctamente");
      setNuevo({
        nombre: "",
        documento: "",
        telefono: "",
        email: "",
        pin: "",
        activo: true,
        sedeIds: [],
      });
    } catch {
      setMensaje("Error creando el vendedor");
    } finally {
      setGuardandoNuevo(false);
    }
  };

  const guardarVendedor = async (vendedorId: number) => {
    try {
      setProcesandoId(vendedorId);
      setMensaje("");

      const draft = ediciones[vendedorId];

      const res = await fetch("/api/usuarios/admin", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vendedorId,
          nombre: draft.nombre,
          documento: draft.documento,
          telefono: draft.telefono,
          email: draft.email,
          pin: draft.pin,
          activo: draft.activo,
          sedeIds: draft.sedeIds,
        }),
      });

      const data = (await res.json()) as AdminUsersResponse & {
        error?: string;
        mensaje?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo actualizar el vendedor");
        return;
      }

      applyData(data);
      setMensaje(data.mensaje || "Vendedor actualizado correctamente");
    } catch {
      setMensaje("Error actualizando el vendedor");
    } finally {
      setProcesandoId(null);
    }
  };

  const eliminarVendedor = async (vendedor: SellerItem) => {
    const confirmar = window.confirm(
      `Eliminar el perfil "${vendedor.nombre}"? Se desactivara su PIN y sus asignaciones.`
    );

    if (!confirmar) {
      return;
    }

    try {
      setProcesandoId(vendedor.id);
      setMensaje("");

      const res = await fetch("/api/usuarios/admin", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ vendedorId: vendedor.id }),
      });

      const data = (await res.json()) as AdminUsersResponse & {
        error?: string;
        mensaje?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo eliminar el vendedor");
        return;
      }

      applyData(data);
      setSelectedProfile(null);
      setMensaje(data.mensaje || "Vendedor eliminado correctamente");
    } catch {
      setMensaje("Error eliminando el vendedor");
    } finally {
      setProcesandoId(null);
    }
  };

  if (cargando) {
    return (
      <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
        <div className="mx-auto max-w-7xl rounded-[32px] bg-white px-8 py-12 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Vendedores
          </p>
          <h1 className="mt-3 text-3xl font-black text-slate-950">
            Cargando gestion de vendedores...
          </h1>
        </div>
      </div>
    );
  }

  if (!esAdmin) {
    return (
      <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
        <div className="mx-auto max-w-4xl rounded-[32px] bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700">
            Acceso restringido
          </div>
          <h1 className="mt-4 text-3xl font-black text-slate-950">
            Solo el administrador puede gestionar vendedores
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            Desde aqui asignas vendedores a las sedes y reinicias sus PIN cuando haga falta.
          </p>
          <div className="mt-6">
            <Link
              href="/dashboard"
              className="inline-flex rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Volver al dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <section className="overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#111827_0%,#0f172a_48%,#145a5a_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Administracion
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Vendedores por sede
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-200 md:text-base">
                El acceso a la sede se hace con usuario y clave. Luego cada vendedor entra a su perfil con PIN propio y puede cambiarlo despues.
              </p>
            </div>

            <Link
              href="/dashboard"
              className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/15"
            >
              Volver al dashboard
            </Link>
          </div>
        </section>

        {mensaje && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm font-medium text-slate-700 shadow-sm">
            {mensaje}
          </div>
        )}

        <section className="mt-6 rounded-[30px] bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Nuevo vendedor
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Crear perfil con PIN
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                El PIN inicial debe tener entre 4 y 6 digitos. El vendedor podra cambiarlo desde su perfil.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Nombre completo
              <input
                value={nuevo.nombre}
                onChange={(event) => actualizarNuevo("nombre", event.target.value)}
                placeholder="Ej: Juan Gomez"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Documento
              <input
                value={nuevo.documento}
                onChange={(event) =>
                  actualizarNuevo("documento", sanitizeDocument(event.target.value))
                }
                placeholder="Cedula del vendedor"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Telefono
              <input
                value={nuevo.telefono}
                onChange={(event) =>
                  actualizarNuevo("telefono", sanitizePhone(event.target.value))
                }
                placeholder="+573001112233"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Correo
              <input
                type="email"
                value={nuevo.email}
                onChange={(event) => actualizarNuevo("email", event.target.value)}
                placeholder="correo@finserpay.com"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              PIN inicial
              <input
                type="password"
                value={nuevo.pin}
                onChange={(event) =>
                  actualizarNuevo("pin", sanitizePin(event.target.value))
                }
                placeholder="4 a 6 digitos"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex items-end gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
              <input
                type="checkbox"
                checked={nuevo.activo}
                onChange={(event) => actualizarNuevo("activo", event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Activo
            </label>
          </div>

          <div className="mt-6">
            <p className="text-sm font-semibold text-slate-700">
              Asignacion de sedes
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Marca las sedes en las que este vendedor podra abrir su perfil.
            </p>
            <div className="mt-4">
              <SedeTransferBoard
                sedes={sedes}
                selectedIds={nuevo.sedeIds}
                onToggle={toggleNuevoSede}
              />
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={() => void crearVendedor()}
              disabled={guardandoNuevo}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {guardandoNuevo ? "Creando..." : "Crear vendedor"}
            </button>
          </div>
        </section>

        <section className="mt-6 rounded-[30px] bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Perfiles creados
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                Directorio de usuarios
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Selecciona un perfil para abrir su informacion y editarlo cuando aplique.
              </p>
            </div>

            <select
              value={filtroSede}
              onChange={(event) => setFiltroSede(event.target.value)}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            >
              <option value="">Todas las sedes</option>
              {sedes.map((sede) => (
                <option key={sede.id} value={sede.id}>
                  {sede.nombre}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-3">
            <ProfileColumn
              title="Supervisores"
              count={supervisoresFiltrados.length}
              empty="No hay supervisores para el filtro seleccionado."
            >
              {supervisoresFiltrados.map((seller) => (
                <SellerProfileButton
                  key={seller.id}
                  seller={seller}
                  selected={
                    selectedProfile?.type === "SUPERVISOR" &&
                    selectedProfile.id === seller.id
                  }
                  onClick={() =>
                    setSelectedProfile({ type: "SUPERVISOR", id: seller.id })
                  }
                />
              ))}
            </ProfileColumn>

            <ProfileColumn
              title="Vendedores"
              count={vendedoresOperativosFiltrados.length}
              empty="No hay vendedores para el filtro seleccionado."
            >
              {vendedoresOperativosFiltrados.map((seller) => (
                <SellerProfileButton
                  key={seller.id}
                  seller={seller}
                  selected={
                    selectedProfile?.type === "VENDEDOR" &&
                    selectedProfile.id === seller.id
                  }
                  onClick={() =>
                    setSelectedProfile({ type: "VENDEDOR", id: seller.id })
                  }
                />
              ))}
            </ProfileColumn>

            <ProfileColumn
              title="Administradores"
              count={administradores.length}
              empty="No hay administradores creados."
            >
              {administradores.map((admin) => (
                <AdminProfileButton
                  key={admin.id}
                  admin={admin}
                  selected={
                    selectedProfile?.type === "ADMIN" &&
                    selectedProfile.id === admin.id
                  }
                  onClick={() => setSelectedProfile({ type: "ADMIN", id: admin.id })}
                />
              ))}
            </ProfileColumn>
          </div>

          {!selectedProfile && (
            <div className="mt-6 rounded-[28px] border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-sm text-slate-500">
              Haz clic en un supervisor, vendedor o administrador para abrir su informacion.
            </div>
          )}

          {selectedAdmin && (
            <section className="mt-6 rounded-[28px] border border-slate-200 bg-slate-50/70 p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                    Administrador #{selectedAdmin.id}
                  </div>
                  <h3 className="mt-3 text-2xl font-black text-slate-950">
                    {selectedAdmin.nombre}
                  </h3>
                  <p className="mt-2 text-sm text-slate-500">
                    Usuario de acceso: {selectedAdmin.usuario}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  <p className="font-semibold text-slate-900">
                    {selectedAdmin.activo ? "Perfil activo" : "Perfil inactivo"}
                  </p>
                  <p className="mt-1 text-slate-500">Rol: {selectedAdmin.rolNombre}</p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Sede base
                  </p>
                  <p className="mt-2 font-black text-slate-950">
                    {selectedAdmin.sede.nombre}
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Creado
                  </p>
                  <p className="mt-2 font-black text-slate-950">
                    {formatDate(selectedAdmin.createdAt)}
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Actualizado
                  </p>
                  <p className="mt-2 font-black text-slate-950">
                    {formatDate(selectedAdmin.updatedAt)}
                  </p>
                </div>
              </div>
            </section>
          )}

          <div className="mt-6 grid gap-5 xl:grid-cols-2">
            {(selectedSeller ? [selectedSeller] : []).map((vendedor) => {
              const draft = ediciones[vendedor.id];

              if (!draft) {
                return null;
              }

              return (
                <section
                  key={vendedor.id}
                  className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-5"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                        {vendedor.tipoPerfil === "SUPERVISOR"
                          ? "Supervisor"
                          : "Vendedor"}{" "}
                        #{vendedor.id}
                      </div>
                      <h3 className="mt-3 text-2xl font-black text-slate-950">
                        {vendedor.nombre}
                      </h3>
                      <p className="mt-2 text-sm text-slate-500">
                        Ultimo ingreso: {formatDate(vendedor.ultimoIngresoAt)}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                      <p className="font-semibold text-slate-900">
                        {vendedor.activo ? "Perfil activo" : "Perfil inactivo"}
                      </p>
                      <p className="mt-1 text-slate-500">
                        {vendedor.debeCambiarPin
                          ? "Pendiente cambio de PIN"
                          : "PIN actualizado"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Nombre
                      <input
                        value={draft.nombre}
                        onChange={(event) =>
                          actualizarEdicion(vendedor.id, "nombre", event.target.value)
                        }
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Documento
                      <input
                        value={draft.documento}
                        onChange={(event) =>
                          actualizarEdicion(
                            vendedor.id,
                            "documento",
                            sanitizeDocument(event.target.value)
                          )
                        }
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Telefono
                      <input
                        value={draft.telefono}
                        onChange={(event) =>
                          actualizarEdicion(
                            vendedor.id,
                            "telefono",
                            sanitizePhone(event.target.value)
                          )
                        }
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Correo
                      <input
                        type="email"
                        value={draft.email}
                        onChange={(event) =>
                          actualizarEdicion(vendedor.id, "email", event.target.value)
                        }
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Reiniciar PIN
                      <input
                        type="password"
                        value={draft.pin}
                        onChange={(event) =>
                          actualizarEdicion(vendedor.id, "pin", sanitizePin(event.target.value))
                        }
                        placeholder="Solo si deseas cambiarlo"
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex items-end gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={draft.activo}
                        onChange={(event) =>
                          actualizarEdicion(vendedor.id, "activo", event.target.checked)
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Activo
                    </label>
                  </div>

                  <div className="mt-6">
                    <p className="text-sm font-semibold text-slate-700">
                      Sedes del perfil
                    </p>
                    <div className="mt-4">
                      <SedeTransferBoard
                        sedes={sedes}
                        selectedIds={draft.sedeIds}
                        onToggle={(sedeId) => toggleEdicionSede(vendedor.id, sedeId)}
                      />
                    </div>
                  </div>

                    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-xs text-slate-500">
                        <p>Creado: {formatDate(vendedor.createdAt)}</p>
                        <p>Actualizado: {formatDate(vendedor.updatedAt)}</p>
                      </div>

                      <div className="flex flex-col gap-3 sm:flex-row">
                        <button
                          type="button"
                          onClick={() => void eliminarVendedor(vendedor)}
                          disabled={procesandoId === vendedor.id}
                          className="rounded-2xl border border-red-200 bg-white px-5 py-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          Eliminar vendedor
                        </button>

                        <button
                          type="button"
                          onClick={() => void guardarVendedor(vendedor.id)}
                          disabled={procesandoId === vendedor.id}
                          className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {procesandoId === vendedor.id ? "Guardando..." : "Guardar cambios"}
                        </button>
                      </div>
                  </div>
                </section>
              );
            })}

            {selectedProfile && !selectedSeller && !selectedAdmin && (
              <div className="rounded-[28px] border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-sm text-slate-500">
                No se encontro informacion para el perfil seleccionado.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
