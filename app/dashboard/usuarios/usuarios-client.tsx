"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, UserCog, UserRound } from "lucide-react";
import { MetricCard, PageHeader } from "@/app/_components/finser-ui";
import {
  type AvatarPerfilKey,
  type TipoPerfilVendedor,
  type TipoPerfilVisual,
  normalizarAvatarPerfil,
  obtenerAvatarDefaultPorTipo,
  obtenerAvatarPerfilSrc,
  obtenerOpcionesAvatarPorTipo,
} from "@/lib/profile-avatars";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  aliadoAccesoId?: number | null;
  aliadoAccesoNombre?: string | null;
  aliadoAccesoCodigo?: string | null;
  rolId: number;
  rolNombre: string;
};

type SedeItem = {
  id: number;
  nombre: string;
  activa: boolean;
  aliado?: {
    id: number;
    nombre: string;
    codigo: string | null;
  } | null;
};

type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activo: boolean;
};

type SellerItem = {
  id: number;
  nombre: string;
  tipoPerfil: TipoPerfilVendedor;
  avatarKey: AvatarPerfilKey;
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
  avatarKey: AvatarPerfilKey;
  activo: boolean;
  rolNombre: string;
  sede: {
    id: number;
    nombre: string;
    aliado?: {
      id: number;
      nombre: string;
      codigo: string | null;
    } | null;
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

type AliadosResponse = {
  aliados?: AliadoItem[];
};

type TipoPerfilFormulario = TipoPerfilVendedor | "ADMINISTRADOR";

type SellerDraft = {
  nombre: string;
  tipoPerfil: TipoPerfilFormulario;
  avatarKey: AvatarPerfilKey;
  usuario: string;
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

function sanitizeUsername(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function esAliadoFinserPay(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === "FINSERPAY";
}

function AvatarBadge({
  avatarKey,
  label,
  size = "small",
}: {
  avatarKey: AvatarPerfilKey;
  label: string;
  size?: "small" | "large";
}) {
  const dimensions = size === "large" ? "h-24 w-24" : "h-14 w-14";

  return (
    <div
      className={[
        "shrink-0 overflow-hidden rounded-lg border border-[#e4e7ec] bg-white shadow-sm",
        dimensions,
      ].join(" ")}
    >
      <img
        src={obtenerAvatarPerfilSrc(avatarKey)}
        alt={label}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function AvatarSelector({
  tipoPerfil,
  avatarKey,
  onChange,
}: {
  tipoPerfil: TipoPerfilVisual;
  avatarKey: AvatarPerfilKey;
  onChange: (avatarKey: AvatarPerfilKey) => void;
}) {
  const opciones = obtenerOpcionesAvatarPorTipo(tipoPerfil);

  return (
    <div className="rounded-lg border border-[#e4e7ec] bg-[#f8fafb] p-4">
      <p className="text-sm font-semibold text-slate-700">Avatar del perfil</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {opciones.map((opcion) => (
          <button
            key={opcion.value}
            type="button"
            onClick={() => onChange(opcion.value)}
            className={[
              "flex items-center gap-3 rounded-md border px-3 py-3 text-left transition",
              avatarKey === opcion.value
                ? "border-[#7ca613] bg-[#fbfdf5]"
                : "border-[#d0d5dd] bg-white hover:border-[#98a2b3]",
            ].join(" ")}
          >
            <AvatarBadge avatarKey={opcion.value} label={opcion.label} />
            <span className="text-sm font-bold text-slate-900">{opcion.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
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
      <section className="rounded-lg border border-[#d0d5dd] bg-white p-4">
        <p className="text-sm font-semibold text-slate-700">Sedes disponibles</p>
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
          {available.length ? (
            available.map((sede) => (
              <label
                key={sede.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-[#e4e7ec] bg-[#f8fafb] px-4 py-3 text-sm font-semibold text-[#344054] transition hover:border-[#c7df8d] hover:bg-[#fbfdf5]"
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
            <div className="rounded-md border border-dashed border-[#d0d5dd] bg-[#f8fafb] px-4 py-5 text-sm text-[#667085]">
              {sedes.length
                ? "Todas las sedes ya quedaron asignadas."
                : "Este aliado aun no tiene sedes disponibles."}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[#d0d5dd] bg-white p-4">
        <p className="text-sm font-semibold text-slate-700">Sedes asignadas</p>
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
          {selected.length ? (
            selected.map((sede) => (
              <label
                key={sede.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-[#c7df8d] bg-[#fbfdf5] px-4 py-3 text-sm font-semibold text-[#344054] transition hover:bg-[#f2f9df]"
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
            <div className="rounded-md border border-dashed border-[#d0d5dd] bg-[#f8fafb] px-4 py-5 text-sm text-[#667085]">
              Selecciona una o varias sedes para este usuario.
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
    <section className="rounded-lg border border-[#e4e7ec] bg-[#f8fafb] p-4">
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
          <div className="rounded-md border border-dashed border-[#d0d5dd] bg-white px-4 py-5 text-sm text-[#667085]">
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
        "w-full rounded-md border px-4 py-4 text-left transition",
        selected
          ? "border-[#7ca613] bg-[#fbfdf5] shadow-[0_6px_16px_rgba(16,24,40,0.08)]"
          : "border-[#e4e7ec] bg-white hover:border-[#98a2b3]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <AvatarBadge avatarKey={seller.avatarKey} label={seller.nombre} />
          <div className="min-w-0">
            <p className="truncate font-black text-slate-950">{seller.nombre}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {seller.documento || "Sin documento"}
            </p>
          </div>
        </div>
        <span
          className={[
            "rounded-full px-2.5 py-1 text-[11px] font-bold",
            seller.activo
              ? "bg-[#f2f9df] text-[#3f6212]"
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
        "w-full rounded-md border px-4 py-4 text-left transition",
        selected
          ? "border-[#7ca613] bg-[#fbfdf5] shadow-[0_6px_16px_rgba(16,24,40,0.08)]"
          : "border-[#e4e7ec] bg-white hover:border-[#98a2b3]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <AvatarBadge avatarKey={admin.avatarKey} label={admin.nombre} />
          <div className="min-w-0">
            <p className="truncate font-black text-slate-950">{admin.nombre}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Usuario: {admin.usuario}
            </p>
          </div>
        </div>
        <span
          className={[
            "rounded-full px-2.5 py-1 text-[11px] font-bold",
            admin.activo
              ? "bg-[#f2f9df] text-[#3f6212]"
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
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [vendedores, setVendedores] = useState<SellerItem[]>([]);
  const [administradores, setAdministradores] = useState<AdminItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardandoNuevo, setGuardandoNuevo] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);
  const [filtroSede, setFiltroSede] = useState("");
  const [aliadoSeleccionadoId, setAliadoSeleccionadoId] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<SelectedProfile>(null);

  const [nuevo, setNuevo] = useState<SellerDraft>({
    nombre: "",
    tipoPerfil: "VENDEDOR",
    avatarKey: obtenerAvatarDefaultPorTipo("VENDEDOR"),
    usuario: "",
    documento: "",
    telefono: "",
    email: "",
    pin: "",
    activo: true,
    sedeIds: [],
  });

  const [ediciones, setEdiciones] = useState<Record<number, SellerDraft>>({});

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const esAdminCentral = esAdmin && esAliadoFinserPay(user?.aliadoAccesoCodigo);
  const aliadoSeleccionado = aliados.find(
    (aliado) => String(aliado.id) === aliadoSeleccionadoId
  );
  const sedesDelAliado = useMemo(
    () =>
      esAdminCentral && aliadoSeleccionadoId
        ? sedes.filter((sede) => String(sede.aliado?.id) === aliadoSeleccionadoId)
        : sedes,
    [aliadoSeleccionadoId, esAdminCentral, sedes]
  );
  const sedesDelAliadoIds = useMemo(
    () => new Set(sedesDelAliado.map((sede) => sede.id)),
    [sedesDelAliado]
  );

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
            tipoPerfil: item.tipoPerfil,
            avatarKey: normalizarAvatarPerfil(item.avatarKey, item.tipoPerfil),
            usuario: "",
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
      const [sessionRes, usersRes, aliadosRes] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }),
        fetch("/api/usuarios/admin", { cache: "no-store" }),
        fetch("/api/aliados/admin", { cache: "no-store" }),
      ]);

      const sessionData = await sessionRes.json();
      const usersData = (await usersRes.json()) as AdminUsersResponse & {
        error?: string;
      };
      const aliadosData = (await aliadosRes.json()) as AliadosResponse & {
        error?: string;
      };

      if (sessionRes.ok) {
        setUser(sessionData);
      }

      if (aliadosRes.ok) {
        const aliadoItems = Array.isArray(aliadosData.aliados)
          ? aliadosData.aliados
          : [];
        setAliados(aliadoItems);
        setAliadoSeleccionadoId((actual) => {
          if (actual && aliadoItems.some((aliado) => String(aliado.id) === actual)) {
            return actual;
          }

          return aliadoItems[0]?.id ? String(aliadoItems[0].id) : "";
        });
      }

      if (usersRes.ok) {
        applyData(usersData);
      } else {
        setMensaje(usersData.error || "No se pudo cargar la gestion de usuarios");
      }
    } catch {
      setMensaje("Error cargando la gestion de usuarios");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargarTodo();
  }, []);

  useEffect(() => {
    if (!esAdminCentral) {
      return;
    }

    setFiltroSede("");
    setSelectedProfile(null);
    setNuevo((current) => ({
      ...current,
      sedeIds: [],
    }));
  }, [aliadoSeleccionadoId, esAdminCentral]);

  const vendedoresFiltrados = useMemo(() => {
    const base =
      esAdminCentral && aliadoSeleccionadoId
        ? vendedores.filter((item) =>
            item.assignedSedeIds.some((sedeId) => sedesDelAliadoIds.has(sedeId))
          )
        : vendedores;

    if (!filtroSede) {
      return base;
    }

    const sedeId = Number(filtroSede || 0);
    return base.filter((item) => item.assignedSedeIds.includes(sedeId));
  }, [
    aliadoSeleccionadoId,
    esAdminCentral,
    filtroSede,
    sedesDelAliadoIds,
    vendedores,
  ]);
  const administradoresFiltrados = useMemo(
    () =>
      esAdminCentral && aliadoSeleccionadoId
        ? administradores.filter(
            (item) => String(item.sede.aliado?.id) === aliadoSeleccionadoId
          )
        : administradores,
    [administradores, aliadoSeleccionadoId, esAdminCentral]
  );
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
  const nuevoEsAdmin = nuevo.tipoPerfil === "ADMINISTRADOR";

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

  const actualizarNuevoTipo = (tipoPerfil: TipoPerfilFormulario) => {
    setNuevo((current) => ({
      ...current,
      tipoPerfil,
      avatarKey:
        tipoPerfil === "ADMINISTRADOR"
          ? obtenerAvatarDefaultPorTipo("ADMINISTRADOR")
          : obtenerAvatarDefaultPorTipo(tipoPerfil),
      sedeIds:
        tipoPerfil === "ADMINISTRADOR"
          ? current.sedeIds.slice(0, 1)
          : current.sedeIds,
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

  const actualizarEdicionTipo = (
    vendedorId: number,
    tipoPerfil: TipoPerfilVendedor
  ) => {
    setEdiciones((current) => ({
      ...current,
      [vendedorId]: {
        ...current[vendedorId],
        tipoPerfil,
        avatarKey: obtenerAvatarDefaultPorTipo(tipoPerfil),
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
          tipoPerfil: nuevo.tipoPerfil,
          avatarKey: nuevo.avatarKey,
          usuario: nuevo.usuario,
          documento: nuevo.documento,
          telefono: nuevo.telefono,
          email: nuevo.email,
          pin: nuevo.pin,
          activo: nuevo.activo,
          sedeId: nuevoEsAdmin ? nuevo.sedeIds[0] || null : undefined,
          sedeIds: nuevo.sedeIds,
        }),
      });

      const data = (await res.json()) as AdminUsersResponse & {
        error?: string;
        mensaje?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear el usuario");
        return;
      }

      applyData(data);
      setMensaje(data.mensaje || "Usuario creado correctamente");
      setNuevo({
        nombre: "",
        tipoPerfil: "VENDEDOR",
        avatarKey: obtenerAvatarDefaultPorTipo("VENDEDOR"),
        usuario: "",
        documento: "",
        telefono: "",
        email: "",
        pin: "",
        activo: true,
        sedeIds: [],
      });
    } catch {
      setMensaje("Error creando el usuario");
    } finally {
      setGuardandoNuevo(false);
    }
  };

  const guardarVendedor = async (vendedorId: number) => {
    try {
      setProcesandoId(vendedorId);
      setMensaje("");

      const draft = ediciones[vendedorId];
      const sedeIds = esAdminCentral
        ? draft.sedeIds.filter((sedeId) => sedesDelAliadoIds.has(sedeId))
        : draft.sedeIds;

      const res = await fetch("/api/usuarios/admin", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vendedorId,
          nombre: draft.nombre,
          tipoPerfil: draft.tipoPerfil,
          avatarKey: draft.avatarKey,
          documento: draft.documento,
          telefono: draft.telefono,
          email: draft.email,
          pin: draft.pin,
          activo: draft.activo,
          sedeIds,
        }),
      });

      const data = (await res.json()) as AdminUsersResponse & {
        error?: string;
        mensaje?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo actualizar el usuario");
        return;
      }

      applyData(data);
      setMensaje(data.mensaje || "Usuario actualizado correctamente");
    } catch {
      setMensaje("Error actualizando el usuario");
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
        setMensaje(data.error || "No se pudo eliminar el usuario");
        return;
      }

      applyData(data);
      setSelectedProfile(null);
      setMensaje(data.mensaje || "Usuario eliminado correctamente");
    } catch {
      setMensaje("Error eliminando el usuario");
    } finally {
      setProcesandoId(null);
    }
  };

  if (cargando) {
    return (
      <div className="mx-auto w-full max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-[#e4e7ec] bg-white px-6 py-12 text-center text-sm font-semibold text-[#667085]">
          Cargando gestion de usuarios...
        </div>
      </div>
    );
  }

  if (!esAdmin) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        <div className="rounded-lg border border-[#e4e7ec] bg-white p-8 shadow-sm">
          <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700">
            Acceso restringido
          </div>
          <h1 className="mt-4 text-3xl font-black text-slate-950">
            Solo el administrador puede gestionar usuarios
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            Desde aqui asignas usuarios a las sedes y reinicias sus PIN cuando haga falta.
          </p>
          <div className="mt-6">
            <Link
              href="/dashboard"
              className="fp-ui-button is-primary"
            >
              Volver al dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
        <PageHeader
          eyebrow="Administracion"
          title="Usuarios y perfiles"
          description="Administra vendedores, supervisores, accesos y cobertura por sede."
        />

        <section className="mt-4 grid gap-3 sm:grid-cols-3">
          <MetricCard className="!rounded-lg !p-4" label={<span className="flex items-center gap-2"><UserRound className="h-4 w-4 text-[#5c7a13]" /> Vendedores</span>} value={<span className="!text-2xl">{vendedoresOperativosFiltrados.length}</span>} detail="Perfiles comerciales" />
          <MetricCard className="!rounded-lg !p-4" label={<span className="flex items-center gap-2"><UserCog className="h-4 w-4 text-[#5c7a13]" /> Supervisores</span>} value={<span className="!text-2xl">{supervisoresFiltrados.length}</span>} detail="Perfiles de control" />
          <MetricCard className="!rounded-lg !p-4" label={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-[#5c7a13]" /> Administradores</span>} value={<span className="!text-2xl">{administradoresFiltrados.length}</span>} detail="Accesos administrativos" />
        </section>

        {mensaje && (
          <div className="mt-4 rounded-lg border border-[#d0d5dd] bg-white px-4 py-3 text-sm font-medium text-[#344054]" role="status">
            {mensaje}
          </div>
        )}

        <section className="mt-4 rounded-lg border border-[#e4e7ec] bg-white p-5 shadow-[0_4px_18px_rgba(16,24,40,0.05)]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
                Nuevo usuario
              </div>
              <h2 className="mt-2 text-xl font-black text-[#151a21]">
                {nuevoEsAdmin ? "Crear administrador" : "Crear perfil con PIN"}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {nuevoEsAdmin
                  ? "El administrador entra con usuario y clave al panel principal."
                  : "El PIN inicial debe tener entre 4 y 6 digitos. El usuario podra cambiarlo desde su perfil."}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {esAdminCentral && (
              <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700 lg:col-span-2">
                Aliado
                <select
                  value={aliadoSeleccionadoId}
                  onChange={(event) => setAliadoSeleccionadoId(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                >
                  {aliados.map((aliado) => (
                    <option key={aliado.id} value={aliado.id}>
                      {aliado.nombre}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Nombre completo
              <input
                value={nuevo.nombre}
                onChange={(event) => actualizarNuevo("nombre", event.target.value)}
                placeholder="Ej: Juan Gomez"
                className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Tipo de perfil
              <select
                value={nuevo.tipoPerfil}
                onChange={(event) =>
                  actualizarNuevoTipo(event.target.value as TipoPerfilFormulario)
                }
                className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                <option value="VENDEDOR">Vendedor</option>
                <option value="SUPERVISOR">Supervisor</option>
                <option value="ADMINISTRADOR">Administrador</option>
              </select>
            </label>

            {nuevoEsAdmin ? (
              <>
                <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                  Usuario de acceso
                  <input
                    value={nuevo.usuario}
                    onChange={(event) =>
                      actualizarNuevo("usuario", sanitizeUsername(event.target.value))
                    }
                    placeholder="admin.sede"
                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                  Sede base
                  <select
                    value={nuevo.sedeIds[0] || ""}
                    onChange={(event) =>
                      actualizarNuevo(
                        "sedeIds",
                        event.target.value ? [Number(event.target.value)] : []
                      )
                    }
                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="">Seleccionar sede</option>
                    {sedesDelAliado.map((sede) => (
                      <option key={sede.id} value={sede.id}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                Documento
                <input
                  value={nuevo.documento}
                  onChange={(event) =>
                    actualizarNuevo("documento", sanitizeDocument(event.target.value))
                  }
                  placeholder="Cedula del usuario"
                  className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </label>
            )}

            {!nuevoEsAdmin && (
            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Telefono
              <input
                value={nuevo.telefono}
                onChange={(event) =>
                  actualizarNuevo("telefono", sanitizePhone(event.target.value))
                }
                placeholder="+573001112233"
                className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>
            )}

            {!nuevoEsAdmin && (
            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              Correo
              <input
                type="email"
                value={nuevo.email}
                onChange={(event) => actualizarNuevo("email", event.target.value)}
                placeholder="correo@finserpay.com"
                className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>
            )}

            <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
              {nuevoEsAdmin ? "Clave inicial" : "PIN inicial"}
              <input
                type="password"
                value={nuevo.pin}
                onChange={(event) =>
                  actualizarNuevo(
                    "pin",
                    nuevoEsAdmin ? event.target.value : sanitizePin(event.target.value)
                  )
                }
                placeholder={nuevoEsAdmin ? "Clave de acceso" : "4 a 6 digitos"}
                className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="flex items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
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
            <AvatarSelector
              tipoPerfil={
                nuevoEsAdmin
                  ? "ADMINISTRADOR"
                  : (nuevo.tipoPerfil as TipoPerfilVendedor)
              }
              avatarKey={nuevo.avatarKey}
              onChange={(avatarKey) => actualizarNuevo("avatarKey", avatarKey)}
            />
          </div>

          {!nuevoEsAdmin && (
          <div className="mt-6">
            <p className="text-sm font-semibold text-slate-700">
              Asignacion de sedes
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Marca las sedes en las que este usuario podra abrir su perfil.
            </p>
            <div className="mt-4">
              <SedeTransferBoard
                sedes={sedesDelAliado}
                selectedIds={nuevo.sedeIds}
                onToggle={toggleNuevoSede}
              />
            </div>
          </div>
          )}

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={() => void crearVendedor()}
              disabled={guardandoNuevo || (esAdminCentral && !aliadoSeleccionadoId)}
              className="fp-ui-button is-primary"
            >
              {guardandoNuevo ? "Creando..." : "Crear usuario"}
            </button>
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-[#e4e7ec] bg-white p-5 shadow-[0_4px_18px_rgba(16,24,40,0.05)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
                Perfiles creados
              </div>
              <h2 className="mt-2 text-xl font-black text-[#151a21]">
                Directorio de usuarios
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {esAdminCentral && aliadoSeleccionado
                  ? `Mostrando perfiles de ${aliadoSeleccionado.nombre}. Selecciona un perfil para abrir su informacion y editarlo cuando aplique.`
                  : "Selecciona un perfil para abrir su informacion y editarlo cuando aplique."}
              </p>
            </div>

            <select
              value={filtroSede}
              onChange={(event) => setFiltroSede(event.target.value)}
              className="fp-ui-input max-w-xs"
            >
              <option value="">Todas las sedes</option>
              {sedesDelAliado.map((sede) => (
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
              count={administradoresFiltrados.length}
              empty="No hay administradores creados."
            >
              {administradoresFiltrados.map((admin) => (
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
            <div className="mt-6 rounded-lg border border-dashed border-[#d0d5dd] bg-[#f8fafb] px-5 py-8 text-sm text-[#667085]">
              Haz clic en un supervisor, vendedor o administrador para abrir su informacion.
            </div>
          )}

          {selectedAdmin && (
            <section className="mt-6 rounded-lg border border-[#e4e7ec] bg-[#f8fafb] p-5">
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

                <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
                  <p className="font-semibold text-slate-900">
                    {selectedAdmin.activo ? "Perfil activo" : "Perfil inactivo"}
                  </p>
                  <p className="mt-1 text-slate-500">Rol: {selectedAdmin.rolNombre}</p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Sede base
                  </p>
                  <p className="mt-2 font-black text-slate-950">
                    {selectedAdmin.sede.nombre}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Creado
                  </p>
                  <p className="mt-2 font-black text-slate-950">
                    {formatDate(selectedAdmin.createdAt)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-4 py-4">
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
                  className="rounded-lg border border-[#e4e7ec] bg-[#f8fafb] p-5"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="flex gap-4">
                      <AvatarBadge
                        avatarKey={draft.avatarKey}
                        label={draft.nombre || vendedor.nombre}
                        size="large"
                      />
                      <div>
                        <div className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                          {draft.tipoPerfil === "SUPERVISOR"
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
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
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
                        className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
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
                        className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
                      Tipo de perfil
                      <select
                        value={draft.tipoPerfil}
                        onChange={(event) =>
                          actualizarEdicionTipo(
                            vendedor.id,
                            event.target.value as TipoPerfilVendedor
                          )
                        }
                        className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      >
                        <option value="VENDEDOR">Vendedor</option>
                        <option value="SUPERVISOR">Supervisor</option>
                      </select>
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
                        className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
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
                        className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
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
                        className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <label className="flex items-end gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
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
                    <AvatarSelector
                      tipoPerfil={draft.tipoPerfil as TipoPerfilVendedor}
                      avatarKey={draft.avatarKey}
                      onChange={(avatarKey) =>
                        actualizarEdicion(vendedor.id, "avatarKey", avatarKey)
                      }
                    />
                  </div>

                  <div className="mt-6">
                    <p className="text-sm font-semibold text-slate-700">
                      Sedes del perfil
                    </p>
                    <div className="mt-4">
                      <SedeTransferBoard
                        sedes={sedesDelAliado}
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
                          className="fp-ui-button is-danger"
                        >
                          Eliminar usuario
                        </button>

                        <button
                          type="button"
                          onClick={() => void guardarVendedor(vendedor.id)}
                          disabled={procesandoId === vendedor.id}
                          className="fp-ui-button is-primary"
                        >
                          {procesandoId === vendedor.id ? "Guardando..." : "Guardar cambios"}
                        </button>
                      </div>
                  </div>
                </section>
              );
            })}

            {selectedProfile && !selectedSeller && !selectedAdmin && (
              <div className="rounded-lg border border-dashed border-[#d0d5dd] bg-[#f8fafb] px-5 py-8 text-sm text-[#667085]">
                No se encontro informacion para el perfil seleccionado.
              </div>
            )}
          </div>
        </section>
    </main>
  );
}
