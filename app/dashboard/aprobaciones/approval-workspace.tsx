"use client";

import { useState } from "react";
import ApprovalConsole from "./approval-console";
import SadminCreditTable from "./sadmin-credit-table";

export default function ApprovalWorkspace({ shared = false, redesigned = false }: { shared?: boolean; redesigned?: boolean }) {
  const [view, setView] = useState<"approvals" | "sadmin">("approvals");

  return view === "sadmin"
    ? <SadminCreditTable onBack={() => setView("approvals")} />
    : <ApprovalConsole shared={shared} redesigned={redesigned} onOpenSadmin={() => setView("sadmin")} />;
}
