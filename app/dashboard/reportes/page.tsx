import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";

const reportCards = [
  {
    href: "/dashboard/reportes/creditos",
    title: "Tabla de creditos",
    description: "Consulta todos los creditos creados, su saldo pendiente y el estado de recaudo.",
  },
  {
    href: "/dashboard/reportes/abonos",
    title: "Tabla de abonos",
    description: "Ve los pagos dia a dia, cuanto se recaudo y cuanto sigue pendiente por cobrar.",
  },
  {
    href: "/dashboard/sedes",
    title: "Puntos de venta",
    description: "Crea sedes y administra el acceso base de cada punto de venta.",
  },
  {
    href: "/dashboard/usuarios",
    title: "Vendedores",
    description: "Crea y administra usuarios vendedores por sede.",
  },
];

export const metadata = {
  title: "Reportes admin | FINSER PAY",
  description: "Centro administrativo para creditos, abonos, sedes y vendedores",
};

export default async function ReportesAdminPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const admin = isAdminRole(session.rolNombre);
  const sellerSession = admin ? null : await getSellerSessionUser(session);

  if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
    return (
      <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
        <div className="mx-auto max-w-4xl rounded-[32px] bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700">
            Acceso restringido
          </div>
          <h1 className="mt-4 text-3xl font-black text-slate-950">
            Solo supervisor o administrador puede ver este centro de reportes
          </h1>
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
        <section className="overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_50%,#145a5a_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Administracion
              </div>
              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Centro de reportes
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-200 md:text-base">
                Desde aqui controlas creditos, abonos, vendedores y sedes del flujo nuevo de FINSER PAY.
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

        <section className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {reportCards
            .filter((card) => admin || !["/dashboard/sedes", "/dashboard/usuarios"].includes(card.href))
            .map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group rounded-[28px] bg-white p-6 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-1 hover:shadow-[0_18px_36px_rgba(15,23,42,0.10)]"
            >
              <div className="inline-flex rounded-full border border-teal-100 bg-teal-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#145a5a]">
                Modulo
              </div>
              <h2 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
                {card.title}
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">{card.description}</p>
              <div className="mt-6 text-sm font-semibold text-[#145a5a]">
                Abrir modulo -
              </div>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
