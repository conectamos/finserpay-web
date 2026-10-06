"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import ApprovalConsole from "./approval-console";
import ApprovalOperations from "./approval-operations";
import SadminCreditTable from "./sadmin-credit-table";
import SharedAccessControl from "./shared-access-control";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "F") + (parts[1]?.[0] || parts[0]?.[1] || "P")).toUpperCase();
}

export default function ApprovalWorkspace({ shared = false, redesigned = false, allowOperations = false,
  canManageSadmin = false, manageLegacySharedAccess = false, userName = "" }: {
  shared?: boolean;
  redesigned?: boolean;
  allowOperations?: boolean;
  canManageSadmin?: boolean;
  manageLegacySharedAccess?: boolean;
  userName?: string;
}) {
  const [view, setView] = useState<"approvals" | "sadmin" | "operations">("approvals");
  const [focusApprovalCreditId, setFocusApprovalCreditId] = useState<number | null>(null);
  const showingDetail = view === "operations" && allowOperations;
  const sectionTitle = showingDetail ? "Detalle del crédito" : view === "sadmin" ? "Listado de créditos" : "Bandeja de aprobaciones";

  return <>
    {!shared ? <header className="flex min-h-[72px] flex-wrap items-center justify-between gap-3 bg-[var(--fp-surface)] px-4 py-3 sm:px-6 lg:px-8">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {allowOperations && showingDetail ? <button type="button" onClick={() => { setFocusApprovalCreditId(null); setView("approvals"); }}
          className="min-h-10 rounded-md text-left text-[clamp(1.25rem,1.8vw,1.65rem)] font-extrabold text-[var(--fp-graphite)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime-strong)]"
          aria-label="Abrir bandeja de aprobaciones">Aprobaciones</button> :
          <span className="text-[clamp(1.25rem,1.8vw,1.65rem)] font-extrabold text-[var(--fp-graphite)]">Aprobaciones</span>}
        <span className="text-2xl text-[var(--fp-muted)]" aria-hidden="true">/</span>
        <h1 className="min-w-0 text-[clamp(1.15rem,1.65vw,1.55rem)] font-semibold text-[var(--fp-muted)]">{sectionTitle}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {allowOperations && !showingDetail ? <button type="button" onClick={() => setView("operations")}
          className="min-h-10 rounded-md px-2 text-sm font-semibold text-[var(--fp-graphite)] underline decoration-[var(--fp-lime-strong)] decoration-2 underline-offset-4 hover:bg-[var(--fp-lime-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime-strong)]">Detalle del crédito</button> : null}
        <span className="grid h-10 w-10 place-items-center text-[var(--fp-graphite)]" aria-label="Notificaciones"><Bell size={21} strokeWidth={1.9} /></span>
        <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--fp-border)] bg-[var(--fp-bg)] text-sm font-semibold text-[var(--fp-graphite)]" aria-label={userName ? `Cuenta de ${userName}` : "Cuenta de FINSER PAY"}>{initials(userName)}</span>
      </div>
    </header> : null}
    {allowOperations && !shared ? <div hidden={!showingDetail}>
      <ApprovalOperations active={showingDetail}
        onOpenApproval={(creditId) => { setFocusApprovalCreditId(creditId); setView("approvals"); }} />
    </div> : null}
    {view === "sadmin" && canManageSadmin
      ? <SadminCreditTable onBack={() => setView("approvals")} />
      : showingDetail ? null
        : <>{manageLegacySharedAccess && !shared ? <SharedAccessControl retirementMode /> : null}
          <ApprovalConsole shared={shared} redesigned={redesigned} focusCreditId={focusApprovalCreditId}
            onOpenSadmin={canManageSadmin ? () => setView("sadmin") : undefined} /></>}
  </>;
}
