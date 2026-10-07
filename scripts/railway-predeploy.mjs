await import("./ensure-aliado-redescuento-schema.mjs");
await import("./ensure-document-blacklist-schema.mjs");
await import("./ensure-ally-payments-schema.mjs");
await import("./ensure-iphone-identity-evidence-column.mjs");
await import("./ensure-datacredito-schema.mjs");
await import("./ensure-credit-amortization-schema.mjs");
await import("./ensure-credit-principal-payment-schema.mjs");
await import("./ensure-solicitudes-schema.mjs");
await import("./ensure-iphone-enrollment-schema.mjs");
await import("./ensure-credit-device-replacement-schema.mjs");
await import("./ensure-credit-device-replacement-remission-schema.mjs");
await import("./ensure-credit-approval-schema.mjs");
await import("./ensure-approval-access-schema.mjs");
await import("./ensure-approval-analyst-account-audit-schema.mjs");
await import("./ensure-approval-evidence-schema.mjs");
await import("./ensure-credit-approval-reissue-schema.mjs");

await import("./ensure-credit-approval-actor-schema.mjs");
await import("./ensure-credit-approval-novelties-schema.mjs");
await import("./ensure-approval-shared-schema.mjs");
await import("./ensure-credit-approval-data-schema.mjs");
await import("./ensure-credit-approval-call-schema.mjs");
await import("./ensure-credit-sadmin-schema.mjs");
await import("./ensure-credit-mass-imei-correction-schema.mjs");
await import("./repair-credit-device-replacement-20260918.mjs");
await import("./correct-historic-mass-credit-first-payments-20260925.mjs");
await import("./ensure-second-credit-authorization-schema.mjs");
await import("./ensure-merchant-applications-schema.mjs");
await import("./ensure-commissions-schema.mjs");
await import("./ensure-approval-operations-schema.mjs");
await import("./ensure-firmaseguro-draft-dispatch-schema.mjs");
await import("./ensure-analyst-mora-schema.mjs");
await import("./ensure-mora-exception-requests-schema.mjs");

// One-off removal of the two explicitly identified synthetic test credits.
// The IDs prevent this operation from running against previews or staging.
if (process.env.RAILWAY_ENVIRONMENT_ID === "80287179-736d-4d4e-85c1-69630c0ee732" &&
    process.env.RAILWAY_SERVICE_ID === "1c3af6e8-656e-4746-b097-9f046de1303e") {
  const { runPurge, PURGE_BOTH_CONFIRMATION } = await import("./purge-synthetic-test-credit-20261007.mjs");
  const result = await runPurge(process.env.DATABASE_URL, {
    allTests: true, execute: true, confirmation: PURGE_BOTH_CONFIRMATION,
  });
  console.log(`SYNTHETIC_TEST_CREDIT_PURGE ${JSON.stringify(result)}`);
  if (!result.eligible || result.targets.some(target => !target.deleted && !target.alreadyAbsent)) {
    throw new Error("SYNTHETIC_TEST_CREDIT_PURGE_BLOCKED");
  }
}
