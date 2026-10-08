"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, ClipboardList, Clock3, Database, Signature, History, LockKeyholeOpen, Search, Smartphone, Wallet, X } from "lucide-react";
import { Badge, Button, EmptyState, Input, LoadingState, StatusPill } from "@/app/_components/finser-ui";
import type { AnalystCenterCase, AnalystCenterDetailResponse, AnalystCenterSearchResponse } from "@/lib/analyst-center-types";
import { isExcludedCarteraCreditState } from "@/lib/cartera-export";
import styles from "./analyst-center.module.css";

const operationModules = [
  { href: "/dashboard/aprobaciones", title: "Aprobaciones", description: "Solicitudes y bienvenida", icon: ClipboardList },
  { href: "/dashboard/aprobaciones/cambio-imei", title: "Cambio de IMEI", description: "Actualiza el equipo asociado", icon: Smartphone },
  { href: "/dashboard/aprobaciones/firma-seguro", title: "Gestionar firma", description: "Envíos y datos de contacto", icon: Signature },
  { href: "/dashboard/aprobaciones/sadmin", title: "Creación Sadmin", description: "Registro y número de crédito", icon: Database },
];
const followUpModules = [
  { href: "/dashboard/aprobaciones/liberar-consulta", title: "Liberar consulta", icon: LockKeyholeOpen },
  { href: "/dashboard/aprobaciones/excepciones-mora", title: "Excepciones de mora", icon: Clock3 },
  { href: "/dashboard/aprobaciones/cartera-mora", title: "Cartera en mora", icon: Wallet },
  { href: "/dashboard/aprobaciones/centro/gestiones", title: "Mis gestiones", icon: History },
];

function identifier(value: string | null | undefined) {
  return value?.replace(/[.\s]/g, "") || "No registrado";
}

function statusTone(status: string): "positive" | "warning" | "danger" | "neutral" {
  if (/MORA|ANUL|RECHAZ|ERROR/i.test(status)) return "danger";
  if (/PEND|BORRADOR|PROCESO|FIRMA/i.test(status)) return "warning";
  if (/PAGADO|FINALIZ|INSCRITO|APROB|ACTIVO|GENERADO/i.test(status)) return "positive";
  return "neutral";
}

function CreditNumber({ item }: { item: { numeroSadmin: string | null; folio: string | null } }) {
  return <div className={styles.creditNumber}>
    {item.numeroSadmin ? <strong>Sadmin: {item.numeroSadmin}</strong> : <Badge tone="warning">PENDIENTE SADMIN</Badge>}
    {item.folio && <span>Folio interno: {item.folio}</span>}
  </div>;
}

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "No se pudo consultar la información. Intenta nuevamente.");
  return payload as T;
}

export default function AnalystCenter() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AnalystCenterCase[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AnalystCenterDetailResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const searchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const detailSection = useRef<HTMLElement>(null);
  useEffect(() => () => { searchRequest.current?.abort(); detailRequest.current?.abort(); }, []);

  async function select(item: Pick<AnalystCenterCase, "kind" | "id">) {
    detailRequest.current?.abort();
    const request = new AbortController();
    detailRequest.current = request;
    setSelected(`${item.kind}-${item.id}`);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const response = await read<AnalystCenterDetailResponse>(`/api/aprobaciones/centro/expediente/${item.kind.toLowerCase()}/${item.id}`, request.signal);
      if (!request.signal.aborted) {
        setDetail(response);
        requestAnimationFrame(() => detailSection.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      }
    } catch (cause) {
      if (!request.signal.aborted) setDetailError(cause instanceof Error ? cause.message : "No se pudo abrir el crédito.");
    } finally {
      if (!request.signal.aborted) setDetailLoading(false);
    }
  }

  async function search() {
    const text = query.trim();
    if (text.length < 3 || text.length > 100) {
      setError("Escribe entre 3 y 100 caracteres para consultar.");
      return;
    }
    searchRequest.current?.abort();
    detailRequest.current?.abort();
    const request = new AbortController();
    searchRequest.current = request;
    setLoading(true);
    setSearched(false);
    setItems([]);
    setDetail(null);
    setSelected(null);
    setDetailLoading(false);
    setDetailError("");
    setError("");
    try {
      const response = await read<AnalystCenterSearchResponse>(`/api/aprobaciones/centro/buscar?q=${encodeURIComponent(text)}`, request.signal);
      if (!request.signal.aborted) {
        setItems(response.items);
        setSearched(true);
        if (response.items.length === 1) void select(response.items[0]);
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudo realizar la consulta.");
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  const credit = detail?.item;
  const canImei = credit && (credit.capabilities.canChangeImei || credit.capabilities.canDispatchSignatureWithImei || credit.capabilities.canFinalizeImei || credit.capabilities.canConfirmReplacement);
  const canSignature = credit && (credit.capabilities.canUpdateContact || credit.capabilities.canSendSignature || credit.capabilities.canResendSignature || credit.capabilities.canRedirectPendingSignature);
  const canSadmin = credit?.kind === "CREDIT" && !isExcludedCarteraCreditState(credit.status);
  const caseId = credit ? `${credit.kind === "CREDIT" ? "C" : "D"}-${credit.id}` : "";
  const caseParams = credit ? `caso=${encodeURIComponent(caseId)}&buscar=${encodeURIComponent(credit.numeroSadmin || credit.folio || credit.document || credit.number)}` : "";

  return <main className={styles.main}>
    <section className={styles.intro}>
      <p className={styles.eyebrow}>CENTRO DEL ANALISTA</p>
      <h1>¿Qué necesitas gestionar?</h1>
      <form className={styles.search} onSubmit={event => { event.preventDefault(); void search(); }} aria-label="Consultar crédito">
        <Search aria-hidden="true" />
        <Input aria-label="Buscar por cédula, crédito, Sadmin o IMEI" placeholder="Buscar por cédula, crédito, Sadmin o IMEI" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} disabled={loading} />
        <Button type="submit" disabled={loading}>{loading ? "Consultando…" : "Consultar"}<ArrowRight aria-hidden="true" /></Button>
      </form>
      <p className={styles.help}>Consulta un crédito para ver sus acciones disponibles.</p>
    </section>

    {error && <div className={styles.error} role="alert">{error}</div>}
    {loading && <div className={styles.results}><LoadingState label="Consultando créditos..." /></div>}
    {searched && !items.length && <EmptyState className={styles.results} title="Sin resultados" description="No se encontraron créditos o solicitudes con ese identificador." />}
    {searched && items.length > 1 && <section className={styles.results} aria-label="Resultados de la consulta">
      <h2>Selecciona un crédito <span>({items.length} coincidencias)</span></h2>
      <div className={styles.resultList}>{items.map(item => <button type="button" key={`${item.kind}-${item.id}`} className={styles.result} aria-pressed={selected === `${item.kind}-${item.id}`} onClick={() => void select(item)}>
        <div><strong>{item.clientName}</strong><span>CC {identifier(item.document)} · Tel. {identifier(item.phone)}</span><span>{item.equipment} · IMEI {identifier(item.imei)}</span></div>
        <CreditNumber item={item} />
        <StatusPill tone={statusTone(item.status)}>{item.status}</StatusPill><ChevronRight aria-hidden="true" />
      </button>)}</div>
    </section>}
    {detailLoading && <div className={styles.results}><LoadingState label="Consultando expediente..." /></div>}
    {detailError && <div className={styles.error} role="alert">{detailError}<Button variant="secondary" onClick={() => { const item = items.find(item => `${item.kind}-${item.id}` === selected); if (item) void select(item); }}>Reintentar</Button></div>}
    {credit && <section ref={detailSection} className={styles.expedient} aria-label="Crédito consultado">
      <header><div><h2>{credit.clientName}</h2><StatusPill tone={statusTone(credit.status)}>{credit.status}</StatusPill></div><Button variant="ghost" aria-label="Cerrar crédito consultado" onClick={() => { setDetail(null); setSelected(null); }}><X aria-hidden="true" /></Button></header>
      <CreditNumber item={credit} />
      <dl className={styles.fields}><div><dt>Cédula</dt><dd>{identifier(credit.document)}</dd></div><div><dt>Teléfono</dt><dd>{identifier(credit.phone)}</dd></div><div><dt>Equipo</dt><dd>{credit.equipment || "No registrado"}</dd></div><div><dt>IMEI</dt><dd>{identifier(credit.imei)}</dd></div></dl>
      <div className={styles.actions}>
        {canImei && <Link href={`/dashboard/aprobaciones/cambio-imei?${caseParams}`}><Smartphone aria-hidden="true" />Cambio de IMEI<ArrowRight aria-hidden="true" /></Link>}
        {canSignature && <Link href={`/dashboard/aprobaciones/firma-seguro?${caseParams}`}><Signature aria-hidden="true" />Gestionar firma<ArrowRight aria-hidden="true" /></Link>}
        {canSadmin && <Link href={`/dashboard/aprobaciones/sadmin?buscar=${encodeURIComponent(credit.numeroSadmin || credit.folio || credit.document || credit.number)}`}><Database aria-hidden="true" />Creación Sadmin<ArrowRight aria-hidden="true" /></Link>}
        <Link href={`/dashboard/aprobaciones/solicitudes/${caseId}`}><ClipboardList aria-hidden="true" />Ver solicitud<ArrowRight aria-hidden="true" /></Link>
      </div>
      {(!canImei && credit.capabilities.reason) && <p className={styles.availability}>{credit.capabilities.reason}</p>}
      {(!canSignature && credit.capabilities.signatureReason) && <p className={styles.availability}>{credit.capabilities.signatureReason}</p>}
      <div className={styles.welcome}><strong>Bienvenida</strong>{detail?.welcome.creditFinalized && credit.kind === "CREDIT" ? <Link href={`/dashboard/aprobaciones?credito=${credit.id}`}>Consultar en Aprobaciones <ArrowRight aria-hidden="true" /></Link> : <span>No disponible aún</span>}</div>
    </section>}

    <div className={styles.groups}>
      <section className={styles.group} aria-labelledby="analyst-operation"><h2 id="analyst-operation">Operación</h2><nav aria-label="Módulos de operación">{operationModules.map(({ href, title, description, icon: Icon }) => <Link className={styles.module} key={href} href={href}><Icon aria-hidden="true" /><span><strong>{title}</strong><span>{description}</span></span><ChevronRight className={styles.arrow} aria-hidden="true" /></Link>)}</nav></section>
      <section className={styles.group} aria-labelledby="analyst-followup"><h2 id="analyst-followup">Gestión y seguimiento</h2><nav aria-label="Módulos de gestión y seguimiento">{followUpModules.map(({ href, title, icon: Icon }) => <Link className={styles.module} key={href} href={href}><Icon aria-hidden="true" /><span><strong>{title}</strong></span><ChevronRight className={styles.arrow} aria-hidden="true" /></Link>)}</nav></section>
    </div>
  </main>;
}
