import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Politica de Privacidad | FINSER PAY",
  description:
    "Politica de privacidad para la app FINSER PAY Clientes y el portal de clientes.",
};

const updatedAt = "19 de mayo de 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[#f6f8f6] px-5 py-10 text-slate-900 sm:px-8">
      <article className="mx-auto max-w-4xl rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-xs font-black uppercase tracking-[0.22em] text-emerald-700">
          FINSER PAY Clientes
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
          Politica de Privacidad
        </h1>
        <p className="mt-3 text-sm font-semibold text-slate-500">
          Ultima actualizacion: {updatedAt}
        </p>

        <section className="mt-8 space-y-4 text-sm leading-7 text-slate-700">
          <p>
            Esta Politica de Privacidad explica como FINSER PAY trata la
            informacion de los usuarios que utilizan la app FINSER PAY Clientes
            y el portal de clientes disponible en finserpay.com/clientes.
          </p>
          <p>
            La app esta dirigida a clientes que desean consultar informacion
            relacionada con su financiacion, cuotas, pagos, medios de pago,
            historial y avisos asociados a su credito.
          </p>
        </section>

        <div className="mt-10 space-y-9">
          <PolicySection title="1. Informacion que podemos tratar">
            <p>
              Podemos tratar datos como nombre, numero de cedula, telefono,
              informacion del credito, referencia del equipo financiado, IMEI,
              estado de cuotas, historial de pagos, medios de pago utilizados,
              identificadores tecnicos del dispositivo y token de notificaciones
              push.
            </p>
          </PolicySection>

          <PolicySection title="2. Finalidades del tratamiento">
            <p>
              Usamos la informacion para permitir el acceso del cliente a su
              estado de cuenta, mostrar cuotas pendientes, registrar o consultar
              pagos, enviar avisos relacionados con el credito, mejorar la
              experiencia de la app, brindar soporte y cumplir obligaciones
              legales, contractuales y operativas.
            </p>
          </PolicySection>

          <PolicySection title="3. Notificaciones">
            <p>
              La app puede enviar notificaciones relacionadas con cuotas,
              recordatorios de pago, estado del credito, avisos de mora y otros
              mensajes operativos. El usuario puede administrar los permisos de
              notificacion desde la configuracion de su dispositivo.
            </p>
          </PolicySection>

          <PolicySection title="4. Pagos y terceros">
            <p>
              Para facilitar pagos, la app puede mostrar o redirigir a medios de
              pago autorizados, incluyendo pasarelas o entidades externas. Los
              datos tratados por esos terceros se rigen tambien por sus propias
              politicas y terminos.
            </p>
          </PolicySection>

          <PolicySection title="5. Conservacion y seguridad">
            <p>
              Conservamos la informacion durante el tiempo necesario para las
              finalidades descritas, para cumplir obligaciones legales y para
              atender solicitudes o reclamaciones. Aplicamos medidas razonables
              de seguridad para proteger la informacion contra acceso,
              alteracion, perdida o uso no autorizado.
            </p>
          </PolicySection>

          <PolicySection title="6. Derechos del titular">
            <p>
              El titular puede solicitar consulta, actualizacion, correccion o
              supresion de sus datos cuando proceda, asi como revocar
              autorizaciones de tratamiento conforme a la ley aplicable. Las
              solicitudes se atienden por los canales de contacto de FINSER PAY.
            </p>
          </PolicySection>

          <PolicySection title="7. Publico objetivo">
            <p>
              FINSER PAY Clientes no esta dirigida a ninos. La app esta pensada
              para clientes y usuarios autorizados que consultan informacion de
              financiaciones y pagos.
            </p>
          </PolicySection>

          <PolicySection title="8. Contacto">
            <p>
              Para preguntas sobre esta politica o sobre el tratamiento de datos,
              puedes contactar a FINSER PAY a traves del sitio web
              finserpay.com o del telefono de soporte registrado en la ficha de
              Google Play.
            </p>
          </PolicySection>

          <PolicySection title="9. Cambios">
            <p>
              FINSER PAY puede actualizar esta Politica de Privacidad. La version
              vigente se publicara en esta misma pagina.
            </p>
          </PolicySection>
        </div>
      </article>
    </main>
  );
}

function PolicySection({
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
