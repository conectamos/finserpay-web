import { syncAllCreditMora } from "@/lib/credit-mora-sync";
import { runCreditDueReminders } from "@/lib/credit-due-reminders";
import { runCreditOverdueDataCampaign } from "@/lib/credit-overdue-data-campaign";
import { dispatchCreditWelcomeVoice } from "@/lib/credit-welcome-voice-dispatch";
import { runVoiceReviewCampaign } from "@/lib/credit-voice-review-campaign";
import { runCollectionVoice, runCollectionMessages } from "@/lib/collection-voice-runtime";
import {
  processPendingDeviceUnlockCommands,
  recoverRecentApprovedWompiUnlockCommands,
} from "@/lib/device-unlock-queue";
import { syncEfectyRecaudosFromSftp } from "@/lib/efecty-recaudos";
import { reconcilePendingWompiPayments } from "@/lib/wompi-reconciliation";
import { getMerchantMailConfig } from "@/lib/merchant-applications";
import { retryMerchantApplications } from "@/lib/merchant-applications-storage";
import {
  getDueInternalCronTasks,
  getStartupRecoveryTasks,
  isCreditCampaignTask,
  type InternalCronTask as ScheduledInternalCronTask,
} from "@/lib/internal-cron-schedule";

const BOGOTA_TIME_ZONE = "America/Bogota";
const CHECK_INTERVAL_MS = 30_000;
const MERCHANT_APPLICATION_INTERVAL_MINUTES = 5;
type InternalCronTask = ScheduledInternalCronTask | "merchant-applications" | "credit-welcome-voice" | "voice-review-campaign" | "collection-voice";

type InternalCronState = {
  completed: Set<string>;
  running: Set<string>;
  started: boolean;
  timer?: ReturnType<typeof setInterval>;
};

declare global {
  var __finserpayInternalCron: InternalCronState | undefined;
}

function getState() {
  globalThis.__finserpayInternalCron ||= {
    completed: new Set<string>(),
    running: new Set<string>(),
    started: false,
  };

  return globalThis.__finserpayInternalCron;
}

function isInternalCronEnabled() {
  const configured = String(process.env.FINSERPAY_INTERNAL_CRON || "").trim().toLowerCase();

  if (["0", "false", "no", "off"].includes(configured)) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(configured)) {
    return true;
  }

  return process.env.NODE_ENV === "production";
}

function getBogotaClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: BOGOTA_TIME_ZONE,
    year: "numeric",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    dateKey: `${byType.year}-${byType.month}-${byType.day}`,
    timeKey: `${byType.hour}:${byType.minute}`,
  };
}

function getMoraEffectiveDate(dateKey: string) {
  // The payment plan changes state at midnight in Colombia. The cron window
  // spans midnight, but it must keep the current Colombian calendar date;
  // carrying the previous day delayed mora automation by almost 24 hours.
  return dateKey;
}

function logCron(message: string, extra?: unknown) {
  if (extra === undefined) {
    console.log(`[finserpay-cron] ${message}`);
    return;
  }

  console.log(`[finserpay-cron] ${message}`, extra);
}

function summarizeReport(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const source = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const key of [
    "ok",
    "generatedAt",
    "campaign",
    "templateKey",
    "payoffRepairs",
    "selection",
    "summary",
    "today",
  ]) {
    if (key in source) {
      summary[key] = source[key];
    }
  }

  return Object.keys(summary).length ? summary : payload;
}

async function runScheduledTask(
  taskName: InternalCronTask,
  runKey: string,
  moraEffectiveDate?: string,
) {
  const state = getState();

  if (state.running.has(taskName) || state.completed.has(runKey)) {
    return;
  }

  state.running.add(taskName);
  let completed = false;

  try {
    if (taskName === "collection-voice") {
      const summary = await runCollectionVoice();
      await runCollectionMessages();
      if (summary.eligible > 0) logCron("Gestiones de voz de cobranza procesadas.", summary);
      completed = true;
      return;
    }
    if (taskName === "voice-review-campaign") {
      const summary = await runVoiceReviewCampaign();
      if (summary.selected > 0) logCron("Llamadas de solicitudes pendientes procesadas.", summary);
      completed = true;
      return;
    }
    if (taskName === "credit-welcome-voice") {
      const summary = await dispatchCreditWelcomeVoice({ limit: 5 });
      if (summary.selected > 0) logCron("Bienvenidas de voz procesadas.", summary);
      completed = true;
      return;
    }
    if (taskName === "credit-overdue-data") {
      const result = await runCreditOverdueDataCampaign({ dryRun: false });
      completed = result.enabled && result.configured && result.inWindow;
      if (completed) {
        logCron("Campana Datos de clientes en mora procesada.", summarizeReport(result));
      }
      return;
    }

    if (taskName === "credit-due-reminders" || taskName === "credit-due-today-reminders") {
      const result = await runCreditDueReminders({
        dryRun: false,
        campaign: taskName === "credit-due-today-reminders" ? "due_today" : "before_due",
      });
      completed = result.enabled && result.configured && result.inWindow;
      if (completed) {
        logCron("Recordatorios de cuotas procesados.", summarizeReport(result));
      }
      return;
    }

    if (taskName === "merchant-applications") {
      // Query the queue only when server credentials and a FINSER PAY sender exist.
      if (getMerchantMailConfig()) {
        const summary = await retryMerchantApplications(10);
        if (summary.selected > 0) {
          logCron("Notificaciones de postulaciones procesadas.", summary);
        }
      }
      completed = true;
      return;
    }

    if (taskName === "unlock") {
      const result = await processPendingDeviceUnlockCommands({ limit: 20 });

      if (result.processed > 0) {
        logCron("Desbloqueos pendientes procesados.", result);
      }

      completed = true;
      return;
    }

    if (taskName === "wompi") {
      logCron("Conciliando pagos Wompi.");
      const result = await reconcilePendingWompiPayments(50);
      logCron("Pagos Wompi conciliados.", summarizeReport(result));
      completed = true;
      return;
    }

    if (taskName === "efecty") {
      logCron("Ejecutando recaudos Efecty.");
      const result = await syncEfectyRecaudosFromSftp({
        dryRun: false,
        includePreviousFiles: true,
        limitFiles: 3,
      });
      logCron("Recaudos Efecty finalizados.", summarizeReport(result));
      completed = true;
      return;
    }

    logCron("Ejecutando mora y bloqueos.");
    const result = await syncAllCreditMora({
      dryRun: false,
      forceRemoteAudit: true,
      today: moraEffectiveDate,
    });
    logCron("Mora y bloqueos finalizados.", summarizeReport(result));
    completed = true;
  } catch (error) {
    if (taskName === "voice-review-campaign") {
      console.error("[finserpay-cron] No se pudo procesar la campana de solicitudes pendientes.");
    } else if (taskName === "credit-welcome-voice") {
      console.error("[finserpay-cron] No se pudo procesar la cola de bienvenidas de voz.");
    } else if (taskName === "credit-overdue-data") {
      console.error("[finserpay-cron] No se pudo procesar la campana Datos de clientes en mora.");
    } else if (taskName === "credit-due-reminders" || taskName === "credit-due-today-reminders") {
      console.error("[finserpay-cron] No se pudo procesar la cola de recordatorios de cuotas.");
    } else if (taskName === "merchant-applications") {
      // Never expose provider/database errors containing merchant data or secrets.
      console.error("[finserpay-cron] No se pudo procesar la cola de postulaciones.");
    } else {
      console.error(
        `[finserpay-cron] Fallo ${taskName}:`,
        error instanceof Error ? error.message : error,
      );
    }
  } finally {
    state.running.delete(taskName);

    if (completed) {
      state.completed.add(runKey);
    }

    if (state.completed.size > 500) {
      for (const key of Array.from(state.completed).slice(0, 250)) {
        state.completed.delete(key);
      }
    }
  }
}

async function tick() {
  const { dateKey, timeKey } = getBogotaClock();
  const dueTasks: InternalCronTask[] = getDueInternalCronTasks(timeKey);
  const minute = Number.parseInt(timeKey.split(":")[1] || "", 10);
  if (Number.isFinite(minute) && minute % MERCHANT_APPLICATION_INTERVAL_MINUTES === 0) {
    dueTasks.push("merchant-applications");
  }
  const moraEffectiveDate = getMoraEffectiveDate(dateKey);

  // The locked outbox prevents duplicate calls across instances. Launch it
  // independently so provider latency cannot delay payment/device tasks.
  void runScheduledTask("credit-welcome-voice", `credit-welcome-voice:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`);
  void runScheduledTask("voice-review-campaign", `voice-review-campaign:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`);
  void runScheduledTask("collection-voice", `collection-voice:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`);

  await runScheduledTask(
    "unlock",
    `unlock:${dateKey}:${timeKey}:${Math.floor(Date.now() / CHECK_INTERVAL_MS)}`,
  );

  // Start all campaigns together so a large batch cannot delay another
  // campaign beyond the shared sending window.
  const campaigns = dueTasks.filter(isCreditCampaignTask);
  await Promise.all(campaigns.map(task => runScheduledTask(task, `${task}:${dateKey}`)));
  for (const taskName of dueTasks.filter(task => !isCreditCampaignTask(task))) {
    await runScheduledTask(
      taskName,
      `${taskName}:${dateKey}:${timeKey}`,
      taskName === "mora" ? moraEffectiveDate : undefined,
    );
  }
}

async function runStartupRecovery() {
  const { dateKey, timeKey } = getBogotaClock();
  const moraEffectiveDate = getMoraEffectiveDate(dateKey);
  void runScheduledTask("credit-welcome-voice", `credit-welcome-voice:startup:${dateKey}:${timeKey}`);
  void runScheduledTask("voice-review-campaign", `voice-review-campaign:startup:${dateKey}:${timeKey}`);

  try {
    const recovered = await recoverRecentApprovedWompiUnlockCommands({
      limit: 200,
    });
    logCron("Ordenes Wompi recientes recuperadas.", recovered);
  } catch (error) {
    console.error(
      "[finserpay-cron] Fallo la recuperacion de desbloqueos Wompi:",
      error instanceof Error ? error.message : error,
    );
  }

  await runScheduledTask(
    "unlock",
    `unlock:startup-recovery:${dateKey}:${timeKey}`,
  );

  const dueTasks = getStartupRecoveryTasks(timeKey);
  // The explicitly configured first batch may recover on its one calendar day
  // even when deployment finishes after the regular Colombian sending window.
  if (String(process.env.DAPTA_DATOS_INITIAL_BATCH_DATE || "").trim() === dateKey
    && !dueTasks.includes("credit-overdue-data")) {
    dueTasks.push("credit-overdue-data");
  }
  await Promise.all(dueTasks.filter(isCreditCampaignTask).map(task => runScheduledTask(task, `${task}:${dateKey}`)));
  for (const taskName of dueTasks.filter(task => !isCreditCampaignTask(task))) {
    await runScheduledTask(
      taskName,
      `${taskName}:startup-recovery:${dateKey}`,
      taskName === "mora" ? moraEffectiveDate : undefined,
    );
  }

  await runScheduledTask(
    "merchant-applications",
    `merchant-applications:startup-recovery:${dateKey}:${timeKey}`,
  );
}

export function startInternalCron() {
  const state = getState();

  if (state.started) {
    return;
  }

  if (!isInternalCronEnabled()) {
    logCron("Programacion interna desactivada.");
    return;
  }

  state.started = true;
  state.timer = setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
  state.timer.unref?.();

  logCron(
    "Programacion interna activa: desbloqueos pendientes cada 30 segundos, Wompi y postulaciones con correo configurado cada 5 minutos, Efecty cada 10 minutos entre 23:10 y 01:50, mora cada 10 minutos entre 23:30 y 01:50, recordatorios de cuotas a las 10:00 y campana Datos de clientes en mora cada 3 dias tras el ultimo envio, con revision diaria a las 10:00 y recuperacion hasta las 11:00; el inicio respeta esas ventanas, hora Colombia.",
  );

  void runStartupRecovery();
}
