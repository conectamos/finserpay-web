"use client";

import { useRouter } from "next/navigation";
import SadminCreditTable from "./sadmin-credit-table";

export default function ApprovalSadminRoute({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();

  return (
    <SadminCreditTable
      initialQuery={initialQuery}
      onBack={() => router.push("/dashboard/aprobaciones")}
    />
  );
}
