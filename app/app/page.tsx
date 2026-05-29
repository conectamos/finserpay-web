import Link from "next/link";
import Image from "next/image";

const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.finserpay.clientes";
const QR_DOWNLOAD_PATH = "/downloads/finserpay-clientes-qr.svg";
const APP_VERSION_LABEL = "Disponible en Google Play";

export const metadata = {
  title: "App Android Clientes | FINSER PAY",
  description: "Instala la app Android de clientes FINSER PAY desde Google Play.",
};

export default function ClientAppDownloadPage() {
  return (
    <main className="min-h-screen bg-[#f4f7f6] px-4 py-6 text-[#20242a] sm:px-6 lg:flex lg:items-center lg:justify-center">
      <section className="mx-auto grid w-full max-w-5xl gap-5 overflow-hidden rounded-[34px] border border-[#d7dce2] bg-white p-5 shadow-[0_28px_80px_rgba(17,19,24,0.12)] md:grid-cols-[1fr_320px] md:p-7">
        <div className="flex min-h-[520px] flex-col justify-between rounded-[28px] border border-[#d7dce2] bg-[#fbfbf7] p-5 sm:p-7">
          <div>
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-[22px] border border-[#d7dce2] bg-white shadow-[0_14px_32px_rgba(17,19,24,0.08)]">
              <Image
                src="/icons/finserpay-client-192.png"
                alt="FINSER PAY"
                width={64}
                height={64}
                className="h-full w-full object-cover"
              />
            </div>

            <p className="mt-8 text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
              App Android actualizada
            </p>
            <h1 className="mt-3 max-w-xl text-4xl font-black leading-[1.05] tracking-tight text-[#111318] sm:text-5xl">
              FINSER PAY Clientes
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-[#687080]">
              Instala la app oficial para consultar cuotas, pagar desde el celular y recibir avisos de pago.
            </p>
            <p className="mt-4 inline-flex rounded-full border border-[#cce7df] bg-white px-4 py-2 text-xs font-black text-[#0f766e]">
              {APP_VERSION_LABEL}
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <a
              href={PLAY_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-14 items-center justify-center rounded-2xl border border-[#0f766e] bg-[#0f766e] px-5 text-center text-sm font-black text-white shadow-[0_16px_32px_rgba(15,118,110,0.22)] transition hover:-translate-y-0.5"
            >
              Abrir en Google Play
            </a>
            <Link
              href="/clientes"
              className="inline-flex min-h-14 items-center justify-center rounded-2xl border border-[#d7dce2] bg-white px-5 text-center text-sm font-black text-[#20242a] transition hover:-translate-y-0.5"
            >
              Abrir portal
            </Link>
          </div>
        </div>

        <aside className="flex flex-col justify-between rounded-[28px] border border-[#cce7df] bg-[#eff8f5] p-5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
              Codigo QR
            </p>
            <h2 className="mt-3 text-2xl font-black leading-tight text-[#173c38]">
              Escanea para instalar
            </h2>
          </div>

          <div className="my-7 rounded-[26px] border border-[#d7dce2] bg-white p-4 shadow-[0_18px_42px_rgba(17,19,24,0.08)]">
            <Image
              src={QR_DOWNLOAD_PATH}
              alt="QR de descarga de la app FINSER PAY Clientes"
              width={720}
              height={720}
              className="aspect-square w-full rounded-[18px]"
            />
          </div>

          <p className="rounded-[22px] border border-[#cce7df] bg-white/72 p-4 text-sm font-bold leading-6 text-[#2f625c]">
            Si ya tenias una version anterior, instala o actualiza desde Google Play para recibir futuras versiones automaticamente.
          </p>
        </aside>
      </section>
    </main>
  );
}
