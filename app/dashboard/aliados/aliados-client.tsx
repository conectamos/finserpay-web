"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Building2,
  ChevronDown,
  CircleDollarSign,
  CreditCard,
  Handshake,
  MapPin,
  Percent,
  Plus,
  Save,
  Store,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  MetricCard,
  PageHeader,
  StatusPill,
} from "@/app/_components/finser-ui";

type SedeItem = {
  id: number;
  nombre: string;
  codigo: string | null;
};

type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
  activo: boolean;
  redescuentoPorcentaje: number;
  sedes: SedeItem[];
  totalSedes: number;
  totalCreditos: number;
  totalRecaudos: number;
};

type NuevaSedeState = {
  nombre: string;
  codigo: string;
  usuario: string;
  clave: string;
};

type AliadosPayload = {
  scope?: {
    central: boolean;
    aliadoId: number | null;
  };
  sistemaCentral?: AliadoItem | null;
  aliados: AliadoItem[];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CO").format(value || 0);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function slugUsuarioSede(valor: string) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizarUsuarioLogin(valor: string) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

function usuarioSugeridoSede(aliado: Pick<AliadoItem, "codigo" | "nombre">, sedeNombre: string) {
  const aliadoSlug = slugUsuarioSede(aliado.codigo || aliado.nombre);
  const sedeSlug = slugUsuarioSede(sedeNombre);

  return [aliadoSlug, sedeSlug].filter(Boolean).join(".");
}

function emptySedeForm(): NuevaSedeState {
  return {
    nombre: "",
    codigo: "",
    usuario: "",
    clave: "",
  };
}

export default function AliadosClient() {
  const [sistemaCentral, setSistemaCentral] = useState<AliadoItem | null>(null);
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [mensaje, setMensaje] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [procesandoId, setProcesandoId] = useState<number | null>(null);
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");
  const [redescuentoPorcentaje, setRedescuentoPorcentaje] = useState("10");
  const [redescuentoInputs, setRedescuentoInputs] = useState<Record<number, string>>({});
  const [sedesForm, setSedesForm] = useState<Record<number, NuevaSedeState>>({});
  const [esCentral, setEsCentral] = useState(true);

  const cargarAliados = async () => {
    try {
      setMensaje("");
      const res = await fetch("/api/aliados/admin", { cache: "no-store" });
      const data = (await res.json()) as Partial<AliadosPayload> & {
        error?: string;
      };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo cargar la gestion de aliados");
        return;
      }

      const items = Array.isArray(data.aliados) ? data.aliados : [];
      setSistemaCentral(data.sistemaCentral || null);
      setAliados(items);
      setEsCentral(Boolean(data.scope?.central));
      setRedescuentoInputs(
        items.reduce((acc: Record<number, string>, aliado) => {
          acc[aliado.id] = String(Number(aliado.redescuentoPorcentaje || 0));
          return acc;
        }, {})
      );
      setSedesForm((actual) =>
        items.reduce((acc: Record<number, NuevaSedeState>, aliado) => {
          acc[aliado.id] = actual[aliado.id] || emptySedeForm();
          return acc;
        }, {})
      );
    } catch {
      setMensaje("Error cargando la gestion de aliados");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    void cargarAliados();
  }, []);

  const crearAliado = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const res = await fetch("/api/aliados/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nombre,
          codigo,
          redescuentoPorcentaje,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear el aliado");
        return;
      }

      setMensaje(data.mensaje || "Aliado creado correctamente");
      setNombre("");
      setCodigo("");
      setRedescuentoPorcentaje("10");
      await cargarAliados();
    } catch {
      setMensaje("Error creando aliado");
    } finally {
      setGuardando(false);
    }
  };

  const actualizarSedeForm = (
    aliadoId: number,
    campo: keyof NuevaSedeState,
    valor: string
  ) => {
    setSedesForm((actual) => {
      const previo = actual[aliadoId] || emptySedeForm();
      const siguiente = {
        ...previo,
        [campo]: valor,
      };

      if (
        campo === "nombre" &&
        (!previo.usuario ||
          previo.usuario === usuarioSugeridoSede(
            aliados.find((aliado) => aliado.id === aliadoId) || {
              codigo: "",
              nombre: "",
            },
            previo.nombre
          ))
      ) {
        const aliado = aliados.find((item) => item.id === aliadoId);
        siguiente.usuario = aliado ? usuarioSugeridoSede(aliado, valor) : slugUsuarioSede(valor);
      }

      return {
        ...actual,
        [aliadoId]: siguiente,
      };
    });
  };

  const crearSede = async (aliado: AliadoItem) => {
    const form = sedesForm[aliado.id] || emptySedeForm();

    try {
      setProcesandoId(aliado.id);
      setMensaje("");

      const res = await fetch("/api/sedes/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          aliadoId: aliado.id,
          nombre: form.nombre,
          codigo: form.codigo,
          usuario: form.usuario,
          clave: form.clave,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo crear la sede");
        return;
      }

      setMensaje(`${data.mensaje || "Sede creada correctamente"} para ${aliado.nombre}`);
      setSedesForm((actual) => ({
        ...actual,
        [aliado.id]: emptySedeForm(),
      }));
      await cargarAliados();
    } catch {
      setMensaje("Error creando sede");
    } finally {
      setProcesandoId(null);
    }
  };

  const actualizarRedescuentoInput = (aliadoId: number, valor: string) => {
    const sanitized = valor.replace(/[^0-9,.]/g, "").replace(",", ".");

    setRedescuentoInputs((actual) => ({
      ...actual,
      [aliadoId]: sanitized,
    }));
  };

  const guardarRedescuento = async (aliado: AliadoItem) => {
    if (!esCentral) {
      return;
    }

    try {
      setProcesandoId(aliado.id);
      setMensaje("");

      const res = await fetch("/api/aliados/admin", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          aliadoId: aliado.id,
          redescuentoPorcentaje:
            redescuentoInputs[aliado.id] ?? aliado.redescuentoPorcentaje,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo actualizar el redescuento");
        return;
      }

      setMensaje(data.mensaje || "Redescuento actualizado correctamente");
      await cargarAliados();
    } catch {
      setMensaje("Error actualizando el redescuento");
    } finally {
      setProcesandoId(null);
    }
  };

  const aliadosActivos = aliados.filter((aliado) => aliado.activo).length;
  const totalSedesComerciales = aliados.reduce(
    (total, aliado) => total + Number(aliado.totalSedes || 0),
    0
  );
  const totalCreditosComerciales = aliados.reduce(
    (total, aliado) => total + Number(aliado.totalCreditos || 0),
    0
  );
  const totalRecaudosComerciales = aliados.reduce(
    (total, aliado) => total + Number(aliado.totalRecaudos || 0),
    0
  );
  const mensajeEsError = /error|no se pudo/i.test(mensaje);

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <PageHeader
        eyebrow="Administracion comercial"
        title="Aliados y cobertura"
        description="Administra aliados, condiciones de redescuento y sedes comerciales."
        actions={
          <Link href="/dashboard/sedes" className="fp-ui-button is-secondary">
            <MapPin className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            Gestionar sedes
          </Link>
        }
      />

      {mensaje ? (
        <div
          className={[
            "mt-4 rounded-lg border px-4 py-3 text-sm font-semibold",
            mensajeEsError
              ? "border-[#f3b7b2] bg-[#fff6f5] text-[#b42318]"
              : "border-[#d9e8ad] bg-[#fbfdf5] text-[#405611]",
          ].join(" ")}
          role={mensajeEsError ? "alert" : "status"}
        >
          {mensaje}
        </div>
      ) : null}

      {cargando ? (
        <Card className="mt-4 !rounded-lg px-5 py-12">
          <LoadingState label="Cargando aliados y sedes..." />
        </Card>
      ) : (
        <>
          <section className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard
              className="!rounded-lg !p-4"
              label={
                <span className="flex items-center gap-2">
                  <Handshake
                    className="h-4 w-4 text-[#5c7a13]"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  Aliados activos
                </span>
              }
              value={<span className="!text-2xl">{aliadosActivos}</span>}
              detail={`${aliados.length} registrados`}
            />
            <MetricCard
              className="!rounded-lg !p-4"
              label={
                <span className="flex items-center gap-2">
                  <Store
                    className="h-4 w-4 text-[#5c7a13]"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  Sedes comerciales
                </span>
              }
              value={<span className="!text-2xl">{formatNumber(totalSedesComerciales)}</span>}
              detail="Cobertura de aliados"
            />
            <MetricCard
              className="!rounded-lg !p-4"
              label={
                <span className="flex items-center gap-2">
                  <CreditCard
                    className="h-4 w-4 text-[#5c7a13]"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  Creditos colocados
                </span>
              }
              value={<span className="!text-2xl">{formatNumber(totalCreditosComerciales)}</span>}
              detail="Operacion comercial"
            />
            <MetricCard
              className="!rounded-lg !p-4"
              label={
                <span className="flex items-center gap-2">
                  <CircleDollarSign
                    className="h-4 w-4 text-[#5c7a13]"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  Recaudos registrados
                </span>
              }
              value={<span className="!text-2xl">{formatNumber(totalRecaudosComerciales)}</span>}
              detail="Pagos de aliados"
            />
          </section>

          {sistemaCentral ? (
            <Card className="mt-4 overflow-hidden !rounded-lg">
              <div className="grid xl:grid-cols-[1.1fr_1fr]">
                <div className="p-5 sm:p-6">
                  <div className="flex items-start gap-4">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[#eef6da] text-[#5c7a13]">
                      <Building2 className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
                        Plataforma central
                      </p>
                      <h2 className="mt-1 text-2xl font-black text-[#151a21]">
                        FINSER PAY
                      </h2>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-[#667085]">
                        Operacion interna, cartera central y administracion global.
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Link href="/dashboard/cartera" className="fp-ui-button is-primary">
                      <CreditCard className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                      Cartera central
                    </Link>
                    <Link href="/dashboard/sedes" className="fp-ui-button is-secondary">
                      <MapPin className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                      Ver sedes internas
                    </Link>
                  </div>
                </div>

                <div className="grid grid-cols-3 border-t border-[#e4e7ec] bg-[#f8fafb] xl:border-l xl:border-t-0">
                  <div className="p-4 sm:p-5">
                    <p className="text-xs font-semibold text-[#667085]">Sedes internas</p>
                    <p className="mt-2 text-2xl font-black text-[#151a21]">
                      {formatNumber(sistemaCentral.totalSedes)}
                    </p>
                  </div>
                  <div className="border-l border-[#e4e7ec] p-4 sm:p-5">
                    <p className="text-xs font-semibold text-[#667085]">Creditos globales</p>
                    <p className="mt-2 text-2xl font-black text-[#151a21]">
                      {formatNumber(sistemaCentral.totalCreditos)}
                    </p>
                  </div>
                  <div className="border-l border-[#e4e7ec] p-4 sm:p-5">
                    <p className="text-xs font-semibold text-[#667085]">Recaudos</p>
                    <p className="mt-2 text-2xl font-black text-[#151a21]">
                      {formatNumber(sistemaCentral.totalRecaudos)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-[#e4e7ec] px-5 py-4 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-bold text-[#151a21]">Sedes del sistema</p>
                    <p className="mt-1 text-xs text-[#667085]">
                      Accesos internos de la plataforma central.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {sistemaCentral.sedes.length ? (
                      sistemaCentral.sedes.map((sede) => (
                        <div
                          key={sede.id}
                          className="flex min-w-0 items-center gap-3 rounded-md border border-[#e4e7ec] bg-white px-3 py-2.5"
                        >
                          <Store className="h-4 w-4 shrink-0 text-[#667085]" strokeWidth={1.8} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold text-[#151a21]">
                              {sede.nombre}
                            </span>
                            <span className="block truncate text-[11px] text-[#667085]">
                              {sede.codigo || `SEDE-${sede.id}`}
                            </span>
                          </span>
                        </div>
                      ))
                    ) : (
                      <span className="text-sm text-[#667085]">
                        No hay sedes internas configuradas.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ) : null}

          {esCentral ? (
            <Card className="mt-4 !rounded-lg p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#eef6da] text-[#5c7a13]">
                  <Plus className="h-5 w-5" strokeWidth={1.9} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
                    Nuevo aliado
                  </p>
                  <h2 className="mt-1 text-xl font-black text-[#151a21]">
                    Registrar aliado comercial
                  </h2>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_0.55fr_0.42fr_170px] lg:items-end">
                <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                  Nombre comercial
                  <Input
                    value={nombre}
                    onChange={(event) => setNombre(event.target.value)}
                    placeholder="Ej: Punto Celular"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                  Codigo
                  <Input
                    value={codigo}
                    onChange={(event) => setCodigo(event.target.value)}
                    placeholder="PUNTO-CELULAR"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                  Redescuento %
                  <Input
                    value={redescuentoPorcentaje}
                    onChange={(event) =>
                      setRedescuentoPorcentaje(
                        event.target.value.replace(/[^0-9,.]/g, "").replace(",", ".")
                      )
                    }
                    inputMode="decimal"
                    placeholder="10"
                  />
                </label>
                <Button
                  onClick={crearAliado}
                  disabled={guardando || !nombre.trim()}
                  className="w-full"
                >
                  <Plus className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                  {guardando ? "Guardando..." : "Crear aliado"}
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="mt-4 overflow-hidden !rounded-lg">
            <div className="flex flex-col gap-3 border-b border-[#e4e7ec] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
                  Red comercial
                </p>
                <h2 className="mt-1 text-xl font-black text-[#151a21]">
                  Aliados registrados
                </h2>
                <p className="mt-1.5 text-sm text-[#667085]">
                  Abre un aliado para administrar su redescuento y cobertura.
                </p>
              </div>
              <Badge tone="neutral">{aliados.length} aliados</Badge>
            </div>

            {aliados.length ? (
              <div className="divide-y divide-[#e4e7ec]">
                {aliados.map((aliado) => {
                  const form = sedesForm[aliado.id] || emptySedeForm();

                  return (
                    <details key={aliado.id} className="group">
                      <summary className="relative grid min-h-24 cursor-pointer list-none gap-4 px-5 py-5 transition hover:bg-[#fbfcfc] sm:px-6 lg:grid-cols-[minmax(240px,1fr)_minmax(520px,1.4fr)_32px] lg:items-center [&::-webkit-details-marker]:hidden">
                        <div className="flex min-w-0 items-center gap-3 pr-10 lg:pr-0">
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[#d9e8ad] bg-[#fbfdf5] text-[#5c7a13]">
                            <Handshake className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-base font-black text-[#151a21]">
                                {aliado.nombre}
                              </span>
                              <StatusPill tone={aliado.activo ? "positive" : "neutral"}>
                                {aliado.activo ? "Activo" : "Inactivo"}
                              </StatusPill>
                            </span>
                            <span className="mt-1 block text-xs font-semibold uppercase text-[#667085]">
                              {aliado.codigo || "Sin codigo"}
                            </span>
                          </span>
                        </div>

                        <span className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                          <span>
                            <span className="block text-[11px] font-semibold text-[#667085]">Sedes</span>
                            <span className="mt-1 block text-base font-black text-[#151a21]">
                              {formatNumber(aliado.totalSedes)}
                            </span>
                          </span>
                          <span>
                            <span className="block text-[11px] font-semibold text-[#667085]">Creditos</span>
                            <span className="mt-1 block text-base font-black text-[#151a21]">
                              {formatNumber(aliado.totalCreditos)}
                            </span>
                          </span>
                          <span>
                            <span className="block text-[11px] font-semibold text-[#667085]">Recaudos</span>
                            <span className="mt-1 block text-base font-black text-[#151a21]">
                              {formatNumber(aliado.totalRecaudos)}
                            </span>
                          </span>
                          <span>
                            <span className="block text-[11px] font-semibold text-[#667085]">Redescuento</span>
                            <span className="mt-1 block text-base font-black text-[#151a21]">
                              {formatPercent(aliado.redescuentoPorcentaje)}%
                            </span>
                          </span>
                        </span>

                        <span className="absolute right-5 top-5 grid h-8 w-8 place-items-center rounded-md text-[#667085] sm:right-6 lg:static">
                          <ChevronDown
                            className="h-5 w-5 transition group-open:rotate-180"
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        </span>
                      </summary>

                      <div className="border-t border-[#e4e7ec] bg-[#f8fafb]">
                        <div className="grid xl:grid-cols-[0.72fr_1.45fr]">
                          {esCentral ? (
                            <section className="border-b border-[#e4e7ec] p-5 sm:p-6 xl:border-b-0 xl:border-r">
                              <div className="flex items-center gap-2">
                                <Percent className="h-4 w-4 text-[#5c7a13]" strokeWidth={1.8} />
                                <h3 className="text-sm font-black text-[#151a21]">
                                  Redescuento de respaldo
                                </h3>
                              </div>
                              <p className="mt-2 text-xs leading-5 text-[#667085]">
                                Porcentaje vigente para la operacion de este aliado.
                              </p>
                              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] xl:grid-cols-1 2xl:grid-cols-[1fr_auto]">
                                <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                                  Porcentaje
                                  <Input
                                    value={
                                      redescuentoInputs[aliado.id] ??
                                      String(Number(aliado.redescuentoPorcentaje || 0))
                                    }
                                    onChange={(event) =>
                                      actualizarRedescuentoInput(aliado.id, event.target.value)
                                    }
                                    inputMode="decimal"
                                    placeholder="0"
                                  />
                                </label>
                                <Button
                                  variant="secondary"
                                  onClick={() => guardarRedescuento(aliado)}
                                  disabled={procesandoId === aliado.id}
                                  className="self-end"
                                >
                                  <Save className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                                  {procesandoId === aliado.id ? "Guardando..." : "Guardar"}
                                </Button>
                              </div>
                            </section>
                          ) : null}

                          <section className="p-5 sm:p-6">
                            <div className="flex items-center gap-2">
                              <MapPin className="h-4 w-4 text-[#5c7a13]" strokeWidth={1.8} />
                              <h3 className="text-sm font-black text-[#151a21]">
                                Crear sede para {aliado.nombre}
                              </h3>
                            </div>
                            <div className="mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-[1fr_0.7fr_1fr_0.8fr_auto] 2xl:items-end">
                              <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                                Nombre de sede
                                <Input
                                  value={form.nombre}
                                  onChange={(event) =>
                                    actualizarSedeForm(aliado.id, "nombre", event.target.value)
                                  }
                                  placeholder="Nombre de sede"
                                />
                              </label>
                              <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                                Codigo
                                <Input
                                  value={form.codigo}
                                  onChange={(event) =>
                                    actualizarSedeForm(aliado.id, "codigo", event.target.value)
                                  }
                                  placeholder="Codigo"
                                />
                              </label>
                              <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                                Usuario de acceso
                                <Input
                                  value={form.usuario}
                                  onChange={(event) =>
                                    actualizarSedeForm(
                                      aliado.id,
                                      "usuario",
                                      normalizarUsuarioLogin(event.target.value)
                                    )
                                  }
                                  placeholder={`${slugUsuarioSede(
                                    aliado.codigo || aliado.nombre
                                  )}.principal`}
                                />
                              </label>
                              <label className="flex flex-col gap-2 text-sm font-semibold text-[#344054]">
                                Clave inicial
                                <Input
                                  value={form.clave}
                                  onChange={(event) =>
                                    actualizarSedeForm(aliado.id, "clave", event.target.value)
                                  }
                                  placeholder="Asignar clave"
                                  type="password"
                                  autoComplete="new-password"
                                />
                              </label>
                              <Button
                                onClick={() => crearSede(aliado)}
                                disabled={
                                  procesandoId === aliado.id ||
                                  !form.nombre.trim() ||
                                  !form.usuario.trim() ||
                                  !form.clave.trim()
                                }
                                className="md:col-span-2 2xl:col-span-1"
                              >
                                <Plus className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                                {procesandoId === aliado.id ? "Creando..." : "Crear sede"}
                              </Button>
                            </div>
                          </section>
                        </div>

                        <section className="border-t border-[#e4e7ec] bg-white px-5 py-5 sm:px-6">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-black text-[#151a21]">Sedes actuales</h3>
                              <p className="mt-1 text-xs text-[#667085]">
                                Cobertura registrada para este aliado.
                              </p>
                            </div>
                            <Badge tone="neutral">{aliado.sedes.length} sedes</Badge>
                          </div>

                          {aliado.sedes.length ? (
                            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                              {aliado.sedes.map((sede) => (
                                <div
                                  key={sede.id}
                                  className="flex min-w-0 items-center gap-3 rounded-md border border-[#e4e7ec] px-3 py-3"
                                >
                                  <Store className="h-4 w-4 shrink-0 text-[#667085]" strokeWidth={1.8} />
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-bold text-[#151a21]">
                                      {sede.nombre}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px] text-[#667085]">
                                      {sede.codigo || `SEDE-${sede.id}`}
                                    </span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-4 text-sm text-[#667085]">
                              Este aliado aun no tiene sedes.
                            </p>
                          )}
                        </section>
                      </div>
                    </details>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                className="m-5"
                title="Aun no hay aliados comerciales"
                description="Crea el primer aliado para comenzar a configurar su cobertura."
              />
            )}
          </Card>
        </>
      )}
    </main>
  );
}
