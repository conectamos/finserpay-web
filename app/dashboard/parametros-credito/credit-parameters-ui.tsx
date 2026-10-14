"use client";

import type { ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Card } from "@/app/_components/finser-ui";
import styles from "./credit-parameters.module.css";

export function ParameterHelp({ title = "Más información", children, compact = false }: { title?: string; children: ReactNode; compact?: boolean }) {
  return <details className={`${styles.help} ${compact ? styles.compactHelp : ""}`}>
    <summary aria-label={title} title={title}><Info size={17} aria-hidden="true" /><span className={compact ? "sr-only" : undefined}>{title}</span></summary>
    <div className={styles.helpBody}>{children}</div>
  </details>;
}

export function ParameterDisclosure({ title, children, number, badge, defaultOpen = false }: {
  title: string; children: ReactNode; number?: string; badge?: ReactNode; defaultOpen?: boolean;
}) {
  return <details className={styles.disclosure} open={defaultOpen}>
    <summary>
      {number ? <span className={styles.ruleNumber}>{number}</span> : null}
      <span className={styles.disclosureTitle}>{title}</span>
      {badge ? <span className={styles.disclosureBadge}>{badge}</span> : null}
      <ChevronDown className={styles.chevron} size={21} aria-hidden="true" />
    </summary>
    <div className={styles.disclosureBody}>{children}</div>
  </details>;
}

export function ParameterSection({ title, children, action, description, id }: {
  title: string; children: ReactNode; action?: ReactNode; description?: ReactNode; id?: string;
}) {
  return <Card className={styles.section} id={id}>
    <div className={styles.sectionHeader}><div><h3 className={styles.heading}>{title}</h3>
      {description ? <p className={styles.muted}>{description}</p> : null}</div>{action}</div>
    {children}
  </Card>;
}
