"use client";
import { Building2, CalendarDays, ChevronDown } from "lucide-react";
import { Select } from "@/app/_components/finser-ui";
import styles from "./admin-central-dashboard.module.css";
export default function DashboardFilters({ sedes, sede, month, scopeLabel, allies, selectedAlly }: {
    sedes: {
        id: number;
        nombre: string;
    }[];
    sede: number | null;
    month: string;
    scopeLabel: string;
    allies: { id: number; nombre: string }[];
    selectedAlly: { id: number; nombre: string } | null;
}) {
    const current = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit" }).formatToParts(new Date());
    const parts = Object.fromEntries(current.map(p => [p.type, p.value]));
    const months = new Set([month, ...Array.from({ length: 24 }, (_, i) => {
            const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1 - i, 1));
            return date.toISOString().slice(0, 7);
        })]);
    return <form action="/dashboard" className={styles.filters}>
    <label><Building2 aria-hidden="true"/><Select name="scope" aria-label="Filtrar por sede" value={sede ? `sede:${sede}` : selectedAlly ? `aliado:${selectedAlly.id}` : ""} onChange={e => e.currentTarget.form?.requestSubmit()}>
      <option value="">{scopeLabel}</option>{allies.length > 0 && <optgroup label="Aliados">{allies.map(a => <option key={a.id} value={`aliado:${a.id}`}>{a.nombre}</option>)}</optgroup>}<optgroup label="Sedes">{sedes.map(s => <option key={s.id} value={`sede:${s.id}`}>{s.nombre}</option>)}</optgroup>
    </Select><ChevronDown aria-hidden="true"/></label>
    <label><CalendarDays aria-hidden="true"/><Select name="month" aria-label="Filtrar por mes" value={month} onChange={e => e.currentTarget.form?.requestSubmit()}>
      {[...months].sort().reverse().map(value => { const label = new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`)).replace(" de ", " "); return <option key={value} value={value}>{label.charAt(0).toUpperCase() + label.slice(1)}</option>; })}
    </Select><ChevronDown aria-hidden="true"/></label>
  </form>;
}
