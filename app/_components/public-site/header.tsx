"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import FinserBrand from "../finser-brand";
import { Button } from "../finser-ui";
import styles from "./public-site.module.css";

export default function PublicHeader() {
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  return (
    <header ref={header} className={styles.headerShell} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { setOpen(false); header.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    }}>
      <div className={`${styles.container} ${styles.header}`}>
        <a className={styles.brand} href="#inicio" aria-label="FINSER PAY, inicio"><FinserBrand dark accentPay wordmarkOnly showTagline={false} /></a>
        <Button variant="ghost" className={styles.menu} aria-label={open ? "Cerrar menú" : "Abrir menú"} aria-expanded={open} aria-controls="public-navigation" onClick={() => setOpen(!open)}>{open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}</Button>
        <nav id="public-navigation" className={`${styles.navigation} ${open ? styles.navigationOpen : ""}`} aria-label="Navegación principal" onClick={() => setOpen(false)}>
          <a href="#clientes">Clientes</a><a href="#pagos">Medios de pago</a><a href="#comercios">Comercios</a><a href="#soporte">Soporte</a><Link href="/aliados">Acceso aliados</Link>
          <Link className={styles.mobilePortal} href="/clientes">Portal de clientes <ArrowRight size={16} aria-hidden="true" /></Link>
        </nav>
        <Link className={styles.headerCta} href="/clientes">Portal de clientes <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </header>
  );
}
