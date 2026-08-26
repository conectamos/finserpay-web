"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Smartphone, X } from "lucide-react";

const CLIENT_APP_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.finserpay.clientes";
const CLIENT_APP_QR_PATH = "/downloads/finserpay-clientes-qr.svg";

export default function SellerClientAppDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (mounted && dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [mounted]);

  const closeDialog = () => {
    dialogRef.current?.close();
    setMounted(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setMounted(true)}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-[var(--fp-graphite)] bg-white px-4 text-sm font-semibold text-[var(--fp-graphite)] transition hover:bg-[var(--fp-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)] focus-visible:ring-offset-2"
      >
        <Smartphone className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
        App de clientes
      </button>

      {mounted ? (
        <dialog
          ref={dialogRef}
          aria-labelledby="client-app-dialog-title"
          onCancel={() => setMounted(false)}
          onClose={() => setMounted(false)}
          onClick={(event) => {
            if (event.currentTarget === event.target) closeDialog();
          }}
          className="m-auto w-[min(92vw,520px)] rounded-lg border border-[var(--fp-border)] bg-white p-0 text-[var(--fp-graphite)] shadow-[var(--fp-shadow-md)] backdrop:bg-black/55"
        >
          <div className="p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--fp-border)] pb-4">
              <div>
                <p className="text-xs font-semibold uppercase text-[var(--fp-lime-strong)]">
                  App de clientes
                </p>
                <h2 id="client-app-dialog-title" className="mt-1 text-xl font-bold">
                  Instalaci&oacute;n y actualizaci&oacute;n
                </h2>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="Cerrar panel de la app de clientes"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-[var(--fp-border)] text-[var(--fp-muted)] transition hover:bg-[var(--fp-bg)] hover:text-[var(--fp-graphite)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)]"
              >
                <X className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>

            <div className="grid gap-5 pt-5 sm:grid-cols-[176px_minmax(0,1fr)] sm:items-center">
              <div className="mx-auto rounded-md border border-[var(--fp-border)] bg-white p-2">
                <Image
                  src={CLIENT_APP_QR_PATH}
                  alt="Codigo QR para instalar FINSER PAY Clientes"
                  width={160}
                  height={160}
                  priority
                />
              </div>
              <div>
                <p className="text-sm leading-6 text-[var(--fp-muted)]">
                  Escanea el c&oacute;digo desde el tel&eacute;fono del cliente para instalar o actualizar la
                  aplicaci&oacute;n al finalizar la venta.
                </p>
                <a
                  href={CLIENT_APP_PLAY_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[var(--fp-graphite)] px-4 text-sm font-semibold text-white transition hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)] focus-visible:ring-offset-2"
                >
                  Abrir Google Play
                  <ExternalLink className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
