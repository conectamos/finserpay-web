"use client";

import Image from "next/image";
import {
  Check,
  Download,
  FileSignature,
  Info,
  LoaderCircle,
  Printer,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
  autoOpen: boolean;
};

const BRAND_LOGO_PATH = "/branding/finserpay-logo.jpg";
const REMISSION_MASCOT_PATH = "/assets/creditos/step-four-remission-phone.png";
const PRINTING_CLASS = "fp-remission-printing";
const REMISSION_SESSION_PREFIX = "finserpay:factory:step-four-remission";

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
  autoOpen,
}: CreditRemissionNoteProps) {
  const [portalReady, setPortalReady] = useState(false);
  const [logoReady, setLogoReady] = useState(false);
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const [printedAt, setPrintedAt] = useState<Date | null>(null);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [printInvoked, setPrintInvoked] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const downloadDialogBackdropRef = useRef<HTMLDivElement>(null);
  const downloadDialogRef = useRef<HTMLElement>(null);
  const downloadDialogTitleRef = useRef<HTMLHeadingElement>(null);
  const downloadDialogId = useId();
  const downloadDialogTitleId = useId();
  const downloadDialogDescriptionId = useId();
  const remissionSessionKey = `${REMISSION_SESSION_PREFIX}:${encodeURIComponent(
    [clienteDocumento, referenciaEquipo, fechaPrimerPago].join("|"),
  )}`;

  useEffect(() => {
    setPortalReady(true);

    const clearPrintMode = () => document.body.classList.remove(PRINTING_CLASS);
    window.addEventListener("afterprint", clearPrintMode);

    return () => {
      window.removeEventListener("afterprint", clearPrintMode);
      clearPrintMode();
    };
  }, []);

  useEffect(() => {
    if (!portalReady) return;

    if (!autoOpen) {
      setDownloadDialogOpen(false);
      return;
    }

    if (window.sessionStorage.getItem(remissionSessionKey) === "confirmed") {
      return;
    }

    setPrintInvoked(false);
    setGenerating(false);
    setDialogError("");
    setDownloadDialogOpen(true);
  }, [autoOpen, portalReady, remissionSessionKey]);

  useEffect(() => {
    if (!portalReady || !downloadDialogOpen) return;

    const backdrop = downloadDialogBackdropRef.current;
    const dialog = downloadDialogRef.current;
    const title = downloadDialogTitleRef.current;
    if (!backdrop || !dialog || !title) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    title.focus();

    const backgroundElements = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== backdrop,
    );
    const backgroundElementStates = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of backgroundElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    const getFocusableElements = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.hasAttribute("hidden") &&
          element.getAttribute("aria-hidden") !== "true",
      );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (printInvoked) {
          window.sessionStorage.setItem(remissionSessionKey, "confirmed");
          setDownloadDialogOpen(false);
        }
        return;
      }
      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        title.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1)!;
      const activeElement = document.activeElement;
      if (!dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        const firstFocusableElement = getFocusableElements()[0];
        if (firstFocusableElement) {
          firstFocusableElement.focus();
        } else {
          title.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      document.body.style.overflow = previousBodyOverflow;
      for (const state of backgroundElementStates) {
        if (!state.element.isConnected) continue;
        state.element.inert = state.inert;
        if (state.ariaHidden === null) {
          state.element.removeAttribute("aria-hidden");
        } else {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        }
      }
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      } else {
        document.getElementById("remission-note-print-action")?.focus();
      }
    };
  }, [downloadDialogOpen, portalReady, printInvoked, remissionSessionKey]);

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
  const visibleDialogError = dialogError
    ? dialogError
    : logoLoadFailed
      ? "No fue posible cargar el logo. Recarga la pantalla antes de descargar la remisión."
      : !dataReady
        ? "Completa los datos obligatorios del cliente y del plan antes de generar la remisión."
        : "";
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

  const closeDownloadDialog = () => {
    if (!printInvoked) return;

    window.sessionStorage.setItem(remissionSessionKey, "confirmed");
    setDownloadDialogOpen(false);
  };

  const handlePrint = () => {
    if (!canPrint || generating || (downloadDialogOpen && printInvoked)) return;

    flushSync(() => {
      setPrintedAt(new Date());
      setGenerating(true);
      setDialogError("");
    });
    document.body.classList.add(PRINTING_CLASS);

    window.requestAnimationFrame(() => {
      try {
        if (downloadDialogOpen) {
          flushSync(() => setPrintInvoked(true));
        }
        window.print();
      } catch (error) {
        if (downloadDialogOpen) {
          setPrintInvoked(false);
        }
        setDialogError(
          error instanceof Error
            ? error.message
            : "No se pudo abrir la impresión de la remisión. Intenta de nuevo.",
        );
      } finally {
        setGenerating(false);
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

  const downloadDialog = downloadDialogOpen ? (
    <div
      ref={downloadDialogBackdropRef}
      className={`fp-ui-dialog-backdrop ${styles.dialogBackdrop}`}
      role="presentation"
    >
      <section
        id={downloadDialogId}
        ref={downloadDialogRef}
        className={styles.downloadDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={downloadDialogTitleId}
        aria-describedby={downloadDialogDescriptionId}
      >
        <header className={styles.dialogHeader}>
          <Image
            src={BRAND_LOGO_PATH}
            alt="FINSER PAY"
            width={1280}
            height={1280}
            preload
            unoptimized
            className={styles.dialogBrand}
          />
          <button
            type="button"
            className={styles.dialogClose}
            aria-label="Cerrar aviso de remisión"
            onClick={closeDownloadDialog}
            disabled={!printInvoked}
          >
            <X aria-hidden="true" />
          </button>
          <span className={styles.dialogWave} aria-hidden="true" />
        </header>

        <div className={styles.dialogBody}>
          <h2
            id={downloadDialogTitleId}
            ref={downloadDialogTitleRef}
            tabIndex={-1}
            className={styles.srOnly}
          >
            Antes de continuar
          </h2>

          <div className={styles.dialogMascot} aria-hidden="true">
            <Image
              src={REMISSION_MASCOT_PATH}
              alt=""
              width={1217}
              height={1293}
              preload
              unoptimized
            />
          </div>

          <div className={styles.dialogCopy}>
            <p
              id={downloadDialogDescriptionId}
              className={styles.dialogDescription}
            >
              Descargue e imprima la remisión del cliente.
            </p>
            <p className={styles.dialogWarning}>
              El cliente debe firmar como en la cédula.
            </p>

            {visibleDialogError ? (
              <p className={styles.dialogError} role="alert">
                {visibleDialogError}
              </p>
            ) : null}

            <button
              type="button"
              className={styles.dialogDownload}
              onClick={handlePrint}
              disabled={!canPrint || generating || printInvoked}
              aria-label={
                printInvoked
                  ? "Remisión descargada"
                  : "Descargar remisión mediante el diálogo de impresión"
              }
            >
              {generating ? (
                <LoaderCircle className={styles.dialogSpinner} aria-hidden="true" />
              ) : printInvoked ? (
                <Check aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {generating
                ? "Generando remisión…"
                : printInvoked
                  ? "Remisión descargada"
                  : "Descargar remisión"}
            </button>

            <button
              type="button"
              className={styles.dialogContinue}
              onClick={closeDownloadDialog}
              disabled={!printInvoked}
            >
              Cerrar y continuar
            </button>

            <p className={styles.dialogNote} aria-live="polite">
              <Info aria-hidden="true" />
              Se habilitará después de descargar la remisión.
            </p>
          </div>
        </div>
      </section>
    </div>
  ) : null;

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
          <Button
            id="remission-note-print-action"
            type="button"
            onClick={handlePrint}
            disabled={!canPrint}
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            Imprimir o guardar PDF
          </Button>
        </div>
      </section>

      {portalReady ? createPortal(downloadDialog, document.body) : null}
      {portalReady ? createPortal(printSheet, document.body) : null}
    </>
  );
}
