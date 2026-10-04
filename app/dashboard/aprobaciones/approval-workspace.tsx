"use client";

import { useState } from "react";
import { Button } from "@/app/_components/finser-ui";
import ApprovalConsole from "./approval-console";
import ApprovalOperations from "./approval-operations";
import SadminCreditTable from "./sadmin-credit-table";

export default function ApprovalWorkspace({ shared = false, redesigned = false, allowOperations = false }: { shared?: boolean; redesigned?: boolean; allowOperations?: boolean }) {
  const [view, setView] = useState<"approvals" | "sadmin" | "operations">(allowOperations ? "operations" : "approvals");

  return <>
    {allowOperations ? <nav aria-label="Vistas de Aprobaciones" className="mx-4 mt-4 flex flex-wrap gap-2 sm:mx-6 lg:mx-8">
      <Button variant={view === "operations" ? "primary" : "secondary"} aria-current={view === "operations" ? "page" : undefined} onClick={() => setView("operations")}>Detalle del crédito</Button>
      <Button variant={view === "approvals" || view === "sadmin" ? "primary" : "secondary"} aria-current={view === "approvals" || view === "sadmin" ? "page" : undefined} onClick={() => setView("approvals")}>Bandeja de aprobaciones</Button>
    </nav> : null}
    {view === "sadmin"
      ? <SadminCreditTable onBack={() => setView("approvals")} />
      : view === "operations" && allowOperations
        ? <ApprovalOperations />
        : <ApprovalConsole shared={shared} redesigned={redesigned} onOpenSadmin={() => setView("sadmin")} />}
  </>;
}
