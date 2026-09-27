"use client";

import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, LoaderCircle, Store } from "lucide-react";
import { Button, Input } from "../finser-ui";
import styles from "./public-site.module.css";

type Receipt = { solicitudId: string; message: string };
type FieldErrors = Record<string, string>;
const fields = [
  { name: "nombreContacto", label: "Nombre del propietario", placeholder: "Tu nombre completo", autoComplete: "name", minLength: 3, maxLength: 120, required: true },
  { name: "nombreComercio", label: "Nombre del comercio", placeholder: "Nombre del negocio", autoComplete: "organization", minLength: 2, maxLength: 160, required: true },
  { name: "telefono", label: "Celular de contacto", placeholder: "Número de contacto", autoComplete: "tel", type: "tel", maxLength: 24, required: true },
  { name: "ciudad", label: "Ciudad", placeholder: "Ciudad de operación", autoComplete: "address-level2", minLength: 2, maxLength: 100, required: true },
  { name: "email", label: "Correo electrónico", placeholder: "correo@negocio.com", autoComplete: "email", type: "email", maxLength: 254, required: true },
  { name: "nit", label: "NIT o documento del comercio (opcional)", placeholder: "NIT o documento", maxLength: 25, required: false },
  { name: "presenciaDigital", label: "Página web, Instagram o Facebook", placeholder: "Enlace o @usuario de tu negocio", minLength: 3, maxLength: 250, required: true },
];

export default function MerchantApplicationForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const submission = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const sending = useRef(false);
  const status = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = Object.fromEntries(fields.map(({ name }) => [name, String(values.get(name) || "").trim()]));
    sending.current = true;
    setBusy(true); setError(""); setErrors({});
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    try {
      const fingerprintBytes = new TextEncoder().encode(JSON.stringify(body));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", fingerprintBytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (submission.current?.fingerprint !== hash) {
        let requestId = crypto.randomUUID();
        try {
          const saved = JSON.parse(sessionStorage.getItem("finserpay-merchant-request") || "null");
          if (saved?.fingerprint === hash && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.requestId)) requestId = saved.requestId;
          sessionStorage.setItem("finserpay-merchant-request", JSON.stringify({ fingerprint: hash, requestId }));
        } catch { /* Private browsing may disable storage; the in-memory key protects retries. */ }
        submission.current = { fingerprint: hash, requestId };
      }
      const response = await fetch("/api/postulaciones", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ ...body, requestId: submission.current.requestId, aceptaPrivacidad: values.get("aceptaPrivacidad") === "on", website: values.get("website") || "" }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        setErrors(result.fields || {});
        throw new Error(result.error || "No pudimos registrar tu postulación. Intenta de nuevo.");
      }
      setReceipt({ solicitudId: result.solicitudId, message: result.message });
      form.reset();
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== "AbortError" && failure.name !== "TypeError"
        ? failure.message
        : "No pudimos confirmar la recepción. Reintenta con los mismos datos; tu solicitud no se duplicará.");
    } finally {
      window.clearTimeout(timeout); sending.current = false; setBusy(false);
      window.setTimeout(() => status.current?.focus(), 0);
    }
  }

  return (
    <div className={styles.formCard}>
      <div className={styles.formTitle}><span><Store size={23} aria-hidden="true" /></span><div><h3>Postula tu comercio</h3><p>Déjanos tus datos y nos comunicaremos contigo.</p></div></div>
      {receipt ? <div className={styles.success} role="status" tabIndex={-1} ref={status}><Check aria-hidden="true" /><h4>¡Recibimos tu postulación!</h4><p>{receipt.message}</p><p className={styles.receipt}>Número de solicitud: <strong>{receipt.solicitudId}</strong></p></div> : (
        <form onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy} className={styles.formFields}>
            {fields.map(({ label, name, ...props }, index) => <label key={name} className={index > 3 ? styles.fullField : undefined} htmlFor={`merchant-${name}`}>
              {label}<Input {...props} name={name} id={`merchant-${name}`} aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `merchant-${name}-error` : undefined} />
              {errors[name] && <span id={`merchant-${name}-error`} className={styles.fieldError}>{errors[name]}</span>}
            </label>)}
            <label className={styles.trap} aria-hidden="true">Sitio web<Input name="website" tabIndex={-1} autoComplete="off" /></label>
            <label className={`${styles.consent} ${styles.fullField}`} htmlFor="merchant-consent"><input id="merchant-consent" type="checkbox" name="aceptaPrivacidad" required /><span>Autorizo a FINSER PAY a usar estos datos para revisar mi solicitud y contactarme sobre la vinculación de mi comercio.</span></label>
          </fieldset>
          {error && <div className={styles.error} role="alert" tabIndex={-1} ref={status}>{error}</div>}
          <Button type="submit" className={styles.submit} disabled={busy}>{busy ? "Enviando postulación…" : "Enviar postulación"}{busy ? <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}</Button>
          <small>La postulación no implica aprobación ni asignación inmediata de código.</small>
        </form>
      )}
    </div>
  );
}
