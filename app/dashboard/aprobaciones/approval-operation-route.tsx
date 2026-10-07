"use client";

import { useRouter } from "next/navigation";
import ApprovalOperations from "./approval-operations";
import type { OperationalCaseSummary } from "@/lib/approval-operations-types";

export default function ApprovalOperationRoute({
  initialQuery = "",
  initialCase,
  preferredPanel,
}: {
  initialQuery?: string;
  initialCase?: Pick<OperationalCaseSummary, "kind" | "id">;
  preferredPanel: "imei" | "signature";
}) {
  const router = useRouter();

  return (
    <ApprovalOperations
      mode={preferredPanel}
      preferredPanel={preferredPanel}
      initialQuery={initialQuery}
      initialCase={initialCase}
      onOpenApproval={(creditId) => {
        router.push(`/dashboard/aprobaciones?credito=${encodeURIComponent(String(creditId))}`);
      }}
    />
  );
}
