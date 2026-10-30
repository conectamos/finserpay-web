import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

export function automationProtectionFixture(database) {
  const protection = loadReissueModule("lib/mora-block-protection.ts", {
    "@/lib/prisma": { default: database },
    "@/lib/mora-block-exemptions": { normalizeMoraExemptionDocument: value => String(value ?? "").replace(/\D/g, ""), ensureMoraBlockExemptionTable: async () => {} },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
  return { hasActiveMoraMessageProtection: protection.hasActiveMoraBlockProtection };
}
