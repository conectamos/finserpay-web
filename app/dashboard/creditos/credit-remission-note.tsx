"use client";

import Image from "next/image";
import { FileSignature, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Button } from "@/app/_components/finser-ui";
import {
  formatCreditRemissionCurrency,
  formatCreditRemissionDate,
  getCreditRemissionPaymentSchedule,
  isCreditRemissionReady,
  type CreditRemissionData,
} from "@/lib/credit-remission";
import styles from "./credit-remission-note.module.css";

type CreditRemissionNoteProps = CreditRemissionData & {
  frecuenciaPago: string;
  ready: boolean;
};

const BRAND_LOGO_PATH = "/branding/finserpay-logo.jpg";
const PRINTING_CLASS = "fp-remission-printing";

export default function CreditRemissionNote({
  clienteNombre,
  clienteDocumento,
  referenciaEquipo,
  valorVenta,
  valorInicial,
  numeroCuotas,
  valorCuota,
  fechaPrimerPago,
  frecuenciaPago,
  ready,
}: CreditRemissionNoteProps) {
  const [portalReady, setPortalReady] = useState(false);
  const [logoReady, setLogoReady] = useState(false);
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const [printedAt, setPrintedAt] = useState<Date | null>(null);

  useEffect(() => {
    setPortalReady(true);

    const clearPrintMode = () => document.body.classList.remove(PRINTING_CLASS);
    window.addEventListener("afterprint", clearPrintMode);

    return () => {
      window.removeEventListener("afterprint", clearPrintMode);
      clearPrintMode();
    };
  }, []);

  const remissionData: CreditRemissionData = {
    clienteNombre,
    clienteDocumento,
    referenciaEquipo,
    valorVenta,
    valorInicial,
    numeroCuotas,
    valorCuota,
    fechaPrimerPago,
  };
  const dataReady = ready && isCreditRemissionReady(remissionData);
  const canPrint = dataReady && portalReady && logoReady;
  const paymentSchedule = getCreditRemissionPaymentSchedule(
    frecuenciaPago,
    fechaPrimerPago,
  );
  const handleLogoLoad = () => {
    setLogoReady(true);
    setLogoLoadFailed(false);
  };
  const handleLogoError = () => {
    setLogoReady(false);
    setLogoLoadFailed(true);
  };

  const handlePrint = () => {
    if (!canPrint) return;

    flushSync(() => {
      setPrintedAt(new Date());
    });
    document.body.classList.add(PRINTING_CLASS);

    window.requestAnimationFrame(() => {
      try {
        window.print();
      } finally {
        document.body.classList.remove(PRINTING_CLASS);
      }
    });
  };

  const printSheet = (
    <article
      className={`fp-remission-print-root ${styles.printSheet}`}
      aria-label="Nota de remisión FINSER PAY"
    >
      <header className={styles.documentHeader}>
        <div className={styles.documentTitle}>
          <span>FINSER PAY</span>
          <h1>NOTA DE REMISIÓN</h1>
        </div>
        <div className={styles.documentLogo}>
          <Image
            src={BRAND_LOGO_PATH}
            alt="Logo de FINSER PAY"
            width={1280}
            height={1280}
            preload
            unoptimized
            onLoad={handleLogoLoad}
            onError={handleLogoError}
          />
        </div>
      </header>

      <table className={styles.dataTable}>
        <tbody>
          <tr>
            <th>Fecha de impresión</th>
            <td>{printedAt ? formatCreditRemissionDate(printedAt) : ""}</td>
          </tr>
          <tr>
            <th>Nombre</th>
            <td>{clienteNombre}</td>
          </tr>
          <tr>
            <th>Documento / CC</th>
            <td>{clienteDocumento}</td>
          </tr>
          <tr>
            <th>Referencia</th>
            <td>{referenciaEquipo}</td>
          </tr>
          <tr>
            <th>Financiera</th>
            <td>FINSERPAY</td>
          </tr>
          <tr>
            <th>Valor venta</th>
            <td>{formatCreditRemissionCurrency(valorVenta)}</td>
          </tr>
          <tr>
            <th>Valor inicial</th>
            <td>{formatCreditRemissionCurrency(valorInicial)}</td>
          </tr>
          <tr>
            <th>N.º cuotas</th>
            <td>{numeroCuotas}</td>
          </tr>
          <tr>
            <th>Valor cuota</th>
            <td>{formatCreditRemissionCurrency(valorCuota)}</td>
          </tr>
          <tr>
            <th>Fechas de pago</th>
            <td>{paymentSchedule}</td>
          </tr>
          <tr>
            <th>Primer pago</th>
            <td>{formatCreditRemissionDate(fechaPrimerPago)}</td>
          </tr>
        </tbody>
      </table>

      <section className={styles.signatureSection}>
        <div className={styles.signatureBox}>
          <strong>Firma del cliente</strong>
          <span>Nombre y firma</span>
        </div>
        <div className={styles.fingerprintBox}>
          <strong>Huella</strong>
          <span>Índice derecho</span>
        </div>
      </section>

      <footer className={styles.documentTerms}>
        <p>
          <strong>1.</strong> El valor reflejado en este documento no incluye costos de financiación.
        </p>
        <p>
          <strong>2.</strong> Al firmar la presente remisión, manifiesto mi conformidad y aceptación de los
          valores detallados anteriormente en este documento.
        </p>
      </footer>
    </article>
  );

  return (
    <>
      <section className={styles.launcher} aria-labelledby="remission-note-title">
        <div className={styles.launcherContent}>
          <span className={styles.launcherIcon} aria-hidden="true">
            <FileSignature />
          </span>
          <div>
            <p className={styles.eyebrow}>Firma y huella del cliente</p>
            <h4 id="remission-note-title">Nota de remisión</h4>
            <p className={styles.launcherDescription} aria-live="polite">
              {logoLoadFailed
                ? "No fue posible cargar el logo. Recarga la pantalla antes de imprimir."
                : dataReady
                  ? "Lista con los datos del crédito para imprimir y firmar."
                  : "Completa los datos del cliente y del plan para habilitar la impresión."}
            </p>
          </div>
        </div>

        <div className={styles.launcherAction}>
          <span className={styles.logoPreview} aria-hidden="true">
            <Image
              src={BRAND_LOGO_PATH}
              alt=""
              width={1280}
              height={1280}
              loading="eager"
              unoptimized
              onLoad={handleLogoLoad}
              onError={handleLogoError}
            />
          </span>
          <Button type="button" onClick={handlePrint} disabled={!canPrint}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            Imprimir nota de remisión
          </Button>
        </div>
      </section>

      {portalReady ? createPortal(printSheet, document.body) : null}
    </>
  );
}
