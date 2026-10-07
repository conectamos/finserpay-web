import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, LockKeyhole } from "lucide-react";
import FinserNavigation from "../_components/finser-navigation";
import styles from "./new-sale-platform-selector.module.css";

type Props = {
  admin: boolean;
  adminCentral: boolean;
  isSupervisor?: boolean;
  androidHref: string;
  iphoneHref: string;
  nombreUsuario: string;
  rolUsuario: string;
};
export default function NewSalePlatformSelector({ admin, adminCentral, isSupervisor = false, androidHref, iphoneHref, nombreUsuario, rolUsuario }: Props) {
  return <div className={styles.screen}>
    <FinserNavigation admin={admin} adminCentral={adminCentral} isSupervisor={isSupervisor} nombreUsuario={nombreUsuario} rolUsuario={rolUsuario} />
    <main className={styles.main}>
      <div className={styles.routeRow}>
        <nav aria-label="Ruta actual" className={styles.breadcrumb}><Link href="/dashboard">Ventas</Link><span aria-hidden="true">/</span><span aria-current="page">Nueva venta</span></nav>
        <Link href="/dashboard" className={styles.back}><ArrowLeft aria-hidden="true" />Volver</Link>
      </div>
      <section className={styles.choice} aria-labelledby="new-sale-heading">
        <p className={styles.eyebrow}>Nueva venta</p>
        <h1 id="new-sale-heading">Elige cómo comenzar</h1>
        <p className={styles.question}>¿Qué equipo vas a financiar?</p>
        <div className={styles.cards}>
          {[
            { platform: "Android", href: androidHref, image: "/assets/creditos/android-symbol-3d.png" },
            { platform: "iPhone", href: iphoneHref, image: "/assets/creditos/apple-symbol-3d.png" },
          ].map(({ platform, href, image }) => <Link key={platform} href={href} className={styles.card} aria-label={`Continuar con ${platform}`}>
            <Image src={image} alt="" width={280} height={280} sizes="(max-width: 600px) 220px, 280px" preload className={styles.symbol} />
            <h2>{platform}</h2>
            <span className={styles.continue}>Continuar<ArrowRight aria-hidden="true" /></span>
          </Link>)}
        </div>
        <p className={styles.secure}><LockKeyhole aria-hidden="true" />Proceso seguro</p>
      </section>
    </main>
  </div>;
}
