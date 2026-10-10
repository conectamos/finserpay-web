"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import styles from "./client-validation-shell.module.css";

export default function ClientValidationHeader({ nombre, rol, canViewPayments, canAssist, assistOpen, onToggleAssist }: {
  nombre: string;
  rol: string;
  canViewPayments: boolean;
  canAssist: boolean;
  assistOpen: boolean;
  onToggleAssist: () => void;
}) {
  const initials = nombre.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "FP";
  return <div className={styles.headerInner}>
    <Link href="/dashboard" className={styles.brand} aria-label="FINSER PAY, ir al panel">
      <FinserBrand compact wordmarkOnly accentPay showTagline={false} />
    </Link>
    <h1>Nueva venta</h1>
    <details className={styles.profileMenu}>
      <summary aria-label={`Abrir menú de ${nombre}, ${rol}`}>
        <span className={styles.avatar} aria-hidden="true">{initials}</span>
        <span className={styles.profileName}>{nombre}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <nav aria-label="Menú de Nueva venta">
        <p>{rol}</p>
        <Link href="/dashboard">Volver al panel</Link>
        {canViewPayments ? <Link href="/dashboard/abonos">Abonos</Link> : null}
        {canAssist ? <button type="button" onClick={onToggleAssist} aria-expanded={assistOpen}>{assistOpen ? "Cerrar asistencia" : "Asistencia"}</button> : null}
      </nav>
    </details>
  </div>;
}
