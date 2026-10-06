"use client";

import { useRouter } from "next/navigation";
import ApprovalOperations from "./approval-operations";

export default function ApprovalOperationRoute({
  initialQuery = "",
  preferredPanel,
}: {
  initialQuery?: string;
  preferredPanel: "imei" | "signature";
}) {
  const router = useRouter();

  return (
    <ApprovalOperations
      mode={preferredPanel}
      preferredPanel={preferredPanel}
      initialQuery={initialQuery}
      onOpenApproval={(creditId) => {
        router.push(`/dashboard/aprobaciones?credito=${encodeURIComponent(String(creditId))}`);
      }}
    />
  );
}
