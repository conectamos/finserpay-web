export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  const { startInternalCron } = await import("./lib/internal-cron");
  startInternalCron();
  const { startSolicitudExportWorker } = await import("./lib/solicitudes-export-jobs");
  startSolicitudExportWorker();
  const { startSettlementDeliveryWorker } = await import("./lib/ally-settlement-delivery-service");
  startSettlementDeliveryWorker();
  const { startAttentionPushWorker } = await import("./lib/atencion-push-worker");
  startAttentionPushWorker();
}
