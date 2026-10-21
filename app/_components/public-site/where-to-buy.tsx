"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Search, MapPin, Phone } from "lucide-react";
import { filterPublicMerchants, merchantMapsUrl, merchantPhoneUrl } from "@/lib/public-merchant-links";
import styles from "./public-site.module.css";

type Merchant = { id: string; nombre: string; direccion: string; telefono: string };

export default function WhereToBuy() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let active = true;
    setStatus("loading");
    fetch("/api/public/comercios", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as { comercios: Merchant[] };
        if (!Array.isArray(data.comercios)) throw new Error("invalid");
        if (active) { setMerchants(data.comercios); setStatus("ready"); }
      })
      .catch(() => { if (active) setStatus("error"); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [attempt]);

  const matches = filterPublicMerchants(merchants, query);

  return (
    <section className={`${styles.section} ${styles.directorySection}`} id="donde-comprar" aria-labelledby="donde-comprar-title">
      <div className={styles.container}>
        <div className={styles.directoryHeading}>
          <p className={styles.sectionLabel}>ALIADOS FINSER PAY</p>
          <h2 id="donde-comprar-title">Encuentra dónde comprar</h2>
          <p className={styles.directoryIntro}>Visita un aliado cercano y solicita tu crédito.</p>
        </div>
        {status === "loading" && <p className={styles.directoryNotice} role="status">Cargando comercios aliados…</p>}
        {status === "error" && <div className={styles.directoryNotice} role="status"><p>No pudimos cargar los comercios. Intenta de nuevo o escríbenos para encontrar un aliado.</p><button type="button" className={`${styles.button} ${styles.directoryRetry}`} onClick={() => setAttempt((value) => value + 1)}>Reintentar</button><a className={styles.textLink} href="https://wa.me/573124085562" target="_blank" rel="noopener noreferrer">Consultar con FINSER PAY <ArrowUpRight size={17} aria-hidden="true" /></a></div>}
        {status === "ready" && <>
          <div className={styles.directoryToolbar}>
            <label className={styles.directorySearch}><Search size={19} aria-hidden="true" /><span className={styles.srOnly}>Buscar comercio aliado</span><input type="search" placeholder="Buscar comercio o ciudad" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <p role="status">{matches.length} {matches.length === 1 ? "aliado" : "aliados"}</p>
          </div>
          {matches.length > 0 ? <ul className={styles.directoryGrid}>{matches.map((merchant) => {
            const mapsUrl = merchantMapsUrl(merchant.direccion);
            const phoneUrl = merchantPhoneUrl(merchant.telefono);
            return <li key={merchant.id} className={styles.directoryCard}>
              <div className={styles.directoryImageFrame}><img className={styles.directoryImage} src={`/api/public/comercios/${merchant.id}/imagen`} alt={merchant.nombre} width={600} height={400} loading="lazy" /></div>
              <div className={styles.directoryDetails}>
                <h3>{merchant.nombre}</h3>
                <a className={styles.directoryAddress} href={mapsUrl} target="_blank" rel="noopener noreferrer" aria-label={`Buscar la dirección de ${merchant.nombre} en Google Maps: ${merchant.direccion}`}><MapPin size={21} aria-hidden="true" /><span>{merchant.direccion} <ArrowUpRight size={16} aria-hidden="true" /></span></a>
                <a className={styles.directoryPhone} href={phoneUrl} aria-label={`Llamar a ${merchant.nombre}: +${merchant.telefono}`}><Phone size={20} aria-hidden="true" /><span>+{merchant.telefono}</span></a>
              </div>
              <div className={styles.directoryActions}>
                <a className={styles.directoryMaps} href={mapsUrl} target="_blank" rel="noopener noreferrer" aria-label={`Ver ${merchant.nombre} en Google Maps`}><MapPin size={20} aria-hidden="true" /><span>Ver en Google Maps <ArrowUpRight size={16} aria-hidden="true" /></span></a>
                <a className={styles.directoryCall} href={phoneUrl} aria-label={`Llamar a ${merchant.nombre}`}><Phone size={20} aria-hidden="true" /><span>Llamar</span></a>
              </div>
            </li>;
          })}</ul> : <p className={styles.directoryNotice}>{merchants.length ? "No encontramos comercios con ese nombre o dirección. Prueba con otra búsqueda." : "Estamos actualizando nuestra red de aliados. Escríbenos para conocer dónde comprar."}</p>}
          <p className={styles.directoryHelp}>Comunícate con el comercio para confirmar disponibilidad antes de tu visita.</p>
        </>}
      </div>
    </section>
  );
}
