"use client";

import { useRouter } from "next/navigation";
import SadminCreditTable from "./sadmin-credit-table";

export default function ApprovalSadminRoute() {
  const router = useRouter();

  return (
    <SadminCreditTable
      analystMode
      onBack={() => router.push("/dashboard/aprobaciones")}
    />
  );
}
