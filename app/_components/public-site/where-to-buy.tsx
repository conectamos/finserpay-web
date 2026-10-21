"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Search, MapPin, Phone } from "lucide-react";
import styles from "./public-site.module.css";

type Merchant = { id: string; nombre: string; direccion: string; telefono: string };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es").trim();

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

  const matches = merchants.filter((merchant) => normalize(`${merchant.nombre} ${merchant.direccion}`).includes(normalize(query)));

  return (
    <section className={`${styles.section} ${styles.directorySection}`} id="donde-comprar" aria-labelledby="donde-comprar-title">
      <div className={styles.container}>
        <div className={styles.split}>
          <div><p className={styles.sectionLabel}>NUESTRA RED DE ALIADOS</p><h2 id="donde-comprar-title">¿Dónde comprar?</h2></div>
          <p>Encuentra un comercio aliado y solicita financiación para tu próximo celular con FINSER PAY.</p>
        </div>
        {status === "loading" && <p className={styles.directoryNotice} role="status">Cargando comercios aliados…</p>}
        {status === "error" && <div className={styles.directoryNotice} role="status"><p>No pudimos cargar los comercios. Intenta de nuevo o escríbenos para encontrar un aliado.</p><button type="button" className={`${styles.button} ${styles.directoryRetry}`} onClick={() => setAttempt((value) => value + 1)}>Reintentar</button><a className={styles.textLink} href="https://wa.me/573124085562" target="_blank" rel="noopener noreferrer">Consultar con FINSER PAY <ArrowUpRight size={17} aria-hidden="true" /></a></div>}
        {status === "ready" && <>
          <div className={styles.directoryToolbar}>
            <label className={styles.directorySearch}><Search size={19} aria-hidden="true" /><span className={styles.srOnly}>Buscar comercio aliado</span><input type="search" placeholder="Busca tu comercio aliado" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <p role="status">{matches.length} {matches.length === 1 ? "comercio aliado" : "comercios aliados"}</p>
          </div>
          {matches.length > 0 ? <ul className={styles.directoryGrid}>{matches.map((merchant) => <li key={merchant.id}>
            <img className={styles.directoryImage} src={`/api/public/comercios/${merchant.id}/imagen`} alt={merchant.nombre} width={600} height={400} loading="lazy" />
            <span className={styles.directoryTag}>Comercio aliado</span>
            <h3>{merchant.nombre}</h3>
            <p className={styles.directoryAddress}><MapPin size={16} aria-hidden="true" />{merchant.direccion}</p>
            <a className={styles.directoryPhone} href={`tel:+${merchant.telefono}`}><Phone size={16} aria-hidden="true" />+{merchant.telefono}</a>
          </li>)}</ul> : <p className={styles.directoryNotice}>{merchants.length ? "No encontramos comercios con ese nombre. Prueba con otra búsqueda." : "Estamos actualizando nuestra red de aliados. Escríbenos para conocer dónde comprar."}</p>}
          <p className={styles.directoryHelp}>Comunícate con el comercio para confirmar disponibilidad antes de tu visita.</p>
        </>}
      </div>
    </section>
  );
}
