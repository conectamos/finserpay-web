"use client";

import { useId, useState, type ReactNode } from "react";
import { FileText, History, LayoutDashboard } from "lucide-react";
import styles from "./analyst-request-detail.module.css";

const tabs = [
  { key: "summary", label: "Resumen", icon: LayoutDashboard },
  { key: "documents", label: "Documentos", icon: FileText },
  { key: "history", label: "Historial", icon: History },
] as const;

export default function AnalystRequestTabs({ summary, documents, history }: {
  summary: ReactNode; documents: ReactNode; history: ReactNode;
}) {
  const [selected, setSelected] = useState<(typeof tabs)[number]["key"]>("summary");
  const id = useId();
  const contents = { summary, documents, history };
  return <>
    <div className={styles.tabs} role="tablist" aria-label="Detalle de la solicitud">
      {tabs.map(({ key, label, icon: Icon }, index) => <button key={key} type="button"
        role="tab" id={`${id}-${key}-tab`} aria-controls={`${id}-${key}-panel`}
        aria-selected={selected === key} tabIndex={selected === key ? 0 : -1}
        onClick={() => setSelected(key)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
            : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); setSelected(tabs[next].key);
          document.getElementById(`${id}-${tabs[next].key}-tab`)?.focus();
        }}><Icon size={18} aria-hidden="true" />{label}</button>)}
    </div>
    {tabs.map(({ key }) => <section key={key} role="tabpanel" id={`${id}-${key}-panel`}
      aria-labelledby={`${id}-${key}-tab`} hidden={selected !== key} tabIndex={0}
      className={styles.tabPanel}>{contents[key]}</section>)}
  </>;
}
