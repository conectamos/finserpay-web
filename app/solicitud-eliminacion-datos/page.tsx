import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Solicitud de Eliminacion de Datos | FINSER PAY",
  description:
    "Instrucciones para solicitar eliminacion de datos asociados a FINSER PAY Clientes.",
};

const updatedAt = "19 de mayo de 2026";

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-[#f6f8f6] px-5 py-10 text-slate-900 sm:px-8">
      <article className="mx-auto max-w-4xl rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-xs font-black uppercase tracking-[0.22em] text-emerald-700">
          FINSER PAY Clientes
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
          Solicitud de eliminacion de datos
        </h1>
        <p className="mt-3 text-sm font-semibold text-slate-500">
          Ultima actualizacion: {updatedAt}
        </p>

        <section className="mt-8 space-y-4 text-sm leading-7 text-slate-700">
          <p>
            Los usuarios de FINSER PAY Clientes pueden solicitar la eliminacion,
            correccion o actualizacion de los datos personales asociados a la
            app y al portal de clientes.
          </p>
          <p>
            Para proteger la seguridad del titular, FINSER PAY puede validar la
            identidad del solicitante antes de procesar la solicitud.
          </p>
        </section>

        <div className="mt-10 space-y-9">
          <InfoSection title="Como solicitarlo">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Contacta a FINSER PAY por los canales de soporte publicados en
                la ficha de Google Play o en finserpay.com.
              </li>
              <li>
                Indica que deseas solicitar eliminacion de datos de FINSER PAY
                Clientes.
              </li>
              <li>
                Incluye tu nombre completo, numero de cedula y telefono de
                contacto para validar la solicitud.
              </li>
              <li>
                FINSER PAY revisara la solicitud y respondera por el canal de
                contacto suministrado.
              </li>
            </ol>
          </InfoSection>

          <InfoSection title="Datos que pueden eliminarse">
            <p>
              Segun corresponda, se podran eliminar o desactivar datos de acceso
              a la app, tokens de notificaciones push, identificadores tecnicos
              de dispositivo y datos que no sean necesarios para cumplir
              obligaciones legales, contractuales, contables o de seguridad.
            </p>
          </InfoSection>

          <InfoSection title="Datos que pueden conservarse">
            <p>
              Algunos datos relacionados con creditos, pagos, comprobantes,
              obligaciones vigentes, historial transaccional, soporte o registros
              exigidos por ley pueden conservarse durante los periodos
              necesarios para cumplir obligaciones legales, contractuales,
              contables, fiscales, de auditoria o defensa ante reclamaciones.
            </p>
          </InfoSection>

          <InfoSection title="Mas informacion">
            <p>
              Consulta tambien la Politica de Privacidad de FINSER PAY Clientes
              en finserpay.com/politica-privacidad.
            </p>
          </InfoSection>
        </div>
      </article>
    </main>
  );
}

function InfoSection({
  children,
  title,
}: Readonly<{
  children: React.ReactNode;
  title: string;
}>) {
  return (
    <section>
      <h2 className="text-lg font-black text-slate-950">{title}</h2>
      <div className="mt-2 text-sm leading-7 text-slate-700">{children}</div>
    </section>
  );
}
