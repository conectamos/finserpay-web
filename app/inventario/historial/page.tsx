import Link from "next/link";
import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

type SearchParams = Promise<{ imei?: string }>;

function formatoPesos(valor: number | null | undefined) {
  if (!valor) return "$ 0";
  return `$ ${Number(valor).toLocaleString("es-CO")}`;
}

function formatoFecha(valor: Date) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(valor);
}

function badgeMovimiento(tipo: string) {
  const valor = String(tipo || "").toUpperCase();

  if (valor.includes("VENTA")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (valor.includes("PRESTAMO")) {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (valor.includes("PAGO")) {
    return "border-violet-200 bg-violet-50 text-violet-700";
  }

  if (valor.includes("ELIM")) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  return "border-slate-200 bg-slate-100 text-slate-700";
}

function badgeFinanciero(estado: string | null) {
  const valor = String(estado || "").toUpperCase();

  if (valor === "PAGO") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (valor === "DEUDA") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (valor === "CANCELADO") {
    return "border-slate-200 bg-slate-100 text-slate-700";
  }

  return "border-slate-200 bg-slate-100 text-slate-500";
}

function valorSeguro(texto: string | null | undefined) {
  return texto?.trim() ? texto : "-";
}

export default async function HistorialInventarioPage(props: {
  searchParams: SearchParams;
}) {
  const user = await getSessionUser();

  if (!user) {
    redirect("/");
  }

  const searchParams = await props.searchParams;
  const imei = searchParams?.imei?.replace(/\D/g, "").trim() || "";

  const movimientos = imei
    ? await prisma.movimientoInventario.findMany({
        where: { imei },
        orderBy: { id: "desc" },
      })
    : [];

  const sedeIds = [...new Set(movimientos.map((item) => item.sedeId).filter((id): id is number => !!id))];
  const sedes = sedeIds.length
    ? await prisma.sede.findMany({
        where: { id: { in: sedeIds } },
        select: { id: true, nombre: true },
      })
    : [];

  const sedesPorId = new Map(sedes.map((sede) => [sede.id, sede.nombre]));
  const ultimoMovimiento = movimientos[0] ?? null;
  const valorHistorial = movimientos.reduce((acc, item) => acc + Number(item.costo || 0), 0);
  const cobertura = user.rolNombre.toUpperCase() === "ADMIN" ? "Todas las sedes" : user.sedeNombre;

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1500px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_220px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                Trazabilidad por IMEI
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Historial de inventario
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                Revisa todos los movimientos registrados para un equipo: cambios de sede, deuda, ventas, prestamos y observaciones operativas.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Cobertura: <span className="font-semibold text-white">{cobertura}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Usuario: <span className="font-semibold text-white">{user.nombre}</span>
                </div>
                {imei && (
                  <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                    IMEI consultado: <span className="font-semibold text-white">{imei}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 xl:items-end">
              <Link
                href="/inventario"
                className="inline-flex h-[56px] min-w-[180px] items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold text-slate-900 transition hover:bg-white"
              >
                Volver
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
          <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
            Busqueda
          </div>
          <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
            Consulta de movimientos
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Escribe un IMEI para reconstruir el historial completo del equipo y ver su paso por inventario, prestamos, deuda y ventas.
          </p>

          <form className="mt-5 flex flex-col gap-4 xl:flex-row">
            <input
              type="text"
              name="imei"
              defaultValue={imei}
              placeholder="Escribe el IMEI"
              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            />

            <button
              type="submit"
              className="inline-flex h-[56px] min-w-[190px] items-center justify-center rounded-2xl bg-[#111318] px-6 text-[15px] font-bold text-white transition hover:bg-[#1d2330]"
            >
              Buscar historial
            </button>
          </form>
        </section>

        <section className="mt-6 grid gap-4 xl:grid-cols-3">
          <div className="rounded-[28px] border border-[#e2d9ca] bg-white p-5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Movimientos encontrados
            </p>
            <p className="mt-3 text-4xl font-black tracking-tight text-slate-950">
              {movimientos.length}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {imei ? "Eventos registrados para este IMEI." : "Aun no hay un IMEI consultado."}
            </p>
          </div>

          <div className="rounded-[28px] border border-[#e2d9ca] bg-white p-5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Ultimo movimiento
            </p>
            <p className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              {ultimoMovimiento?.tipoMovimiento || "Sin consulta"}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {ultimoMovimiento ? formatoFecha(ultimoMovimiento.createdAt) : "Busca un IMEI para ver el corte mas reciente."}
            </p>
          </div>

          <div className="rounded-[28px] border border-[#e2d9ca] bg-white p-5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Valor acumulado
            </p>
            <p className="mt-3 text-4xl font-black tracking-tight text-slate-950">
              {formatoPesos(valorHistorial)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Suma referencial de costos registrados en el historial consultado.
            </p>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-[32px] border border-[#e2d9ca] bg-white shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Resultados
              </div>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                {imei ? `Trazabilidad del IMEI ${imei}` : "Resultados del historial"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Vista cronologica de cada cambio operativo y financiero asociado al equipo.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1320px] text-sm">
              <thead className="sticky top-0 bg-[#f8fafc]">
                <tr className="border-b border-slate-200 text-left text-[12px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-4 py-4">ID</th>
                  <th className="px-4 py-4">IMEI</th>
                  <th className="px-4 py-4">Movimiento</th>
                  <th className="px-4 py-4">Referencia</th>
                  <th className="px-4 py-4">Color</th>
                  <th className="px-4 py-4">Costo</th>
                  <th className="px-4 py-4">Sede</th>
                  <th className="px-4 py-4">Debe a</th>
                  <th className="px-4 py-4">Estado financiero</th>
                  <th className="px-4 py-4">Origen</th>
                  <th className="px-4 py-4">Observacion</th>
                  <th className="px-4 py-4">Fecha</th>
                </tr>
              </thead>

              <tbody>
                {!imei ? (
                  <tr>
                    <td colSpan={12} className="px-6 py-16 text-center text-slate-500">
                      Escribe un IMEI para consultar su historial completo.
                    </td>
                  </tr>
                ) : movimientos.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-6 py-16 text-center text-slate-500">
                      No hay movimientos registrados para este IMEI.
                    </td>
                  </tr>
                ) : (
                  movimientos.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-slate-100 align-top text-slate-700 transition hover:bg-[#faf7f1]"
                    >
                      <td className="px-4 py-4 font-bold text-slate-950">{item.id}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">{item.imei}</td>
                      <td className="px-4 py-4">
                        <span
                          className={[
                            "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                            badgeMovimiento(item.tipoMovimiento),
                          ].join(" ")}
                        >
                          {item.tipoMovimiento}
                        </span>
                      </td>
                      <td className="px-4 py-4">{valorSeguro(item.referencia)}</td>
                      <td className="px-4 py-4">{valorSeguro(item.color)}</td>
                      <td className="px-4 py-4 font-semibold text-slate-950">
                        {item.costo ? formatoPesos(item.costo) : "-"}
                      </td>
                      <td className="px-4 py-4">
                        {item.sedeId ? sedesPorId.get(item.sedeId) || `SEDE ${item.sedeId}` : "-"}
                      </td>
                      <td className="px-4 py-4">{valorSeguro(item.deboA)}</td>
                      <td className="px-4 py-4">
                        <span
                          className={[
                            "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                            badgeFinanciero(item.estadoFinanciero),
                          ].join(" ")}
                        >
                          {item.estadoFinanciero || "-"}
                        </span>
                      </td>
                      <td className="px-4 py-4">{valorSeguro(item.origen)}</td>
                      <td className="px-4 py-4 leading-6 text-slate-600">
                        {valorSeguro(item.observacion)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                        {formatoFecha(item.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
