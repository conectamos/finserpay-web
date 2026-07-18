import { syncAllCreditMora } from "@/lib/credit-mora-sync";
import { syncEfectyRecaudosFromSftp } from "@/lib/efecty-recaudos";
import { reconcilePendingWompiPayments } from "@/lib/wompi-reconciliation";

const BOGOTA_TIME_ZONE = "America/Bogota";
const CHECK_INTERVAL_MS = 30_000;
const EFECTY_INTERVAL_MINUTES = 10;
const EFECTY_WINDOW_START_MINUTE = 23 * 60 + 10;
const EFECTY_WINDOW_END_MINUTE = 1 * 60 + 50;
const MORA_INTERVAL_MINUTES = 10;
const MORA_WINDOW_START_MINUTE = 23 * 60 + 30;
const MORA_WINDOW_END_MINUTE = 1 * 60 + 50;
const WOMPI_INTERVAL_MINUTES = 5;

type InternalCronTask = "efecty" | "mora" | "wompi";

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

function previousDateKey(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function getMoraEffectiveDate(dateKey: string, timeKey: string) {
  const [hourValue = "", minuteValue = ""] = timeKey.split(":");
  const minuteOfDay =
    Number.parseInt(hourValue, 10) * 60 + Number.parseInt(minuteValue, 10);

  return minuteOfDay >= MORA_WINDOW_START_MINUTE
    ? dateKey
    : previousDateKey(dateKey);
}

function getDueTasks(timeKey: string) {
  const tasks: InternalCronTask[] = [];
  const [hourValue = "", minuteValue = ""] = timeKey.split(":");
  const hour = Number.parseInt(hourValue, 10);
  const minute = Number.parseInt(minuteValue, 10);
  const minuteOfDay = hour * 60 + minute;

  if (Number.isFinite(minute) && minute % WOMPI_INTERVAL_MINUTES === 0) {
    tasks.push("wompi");
  }

  const isEfectyWindow =
    minuteOfDay >= EFECTY_WINDOW_START_MINUTE ||
    minuteOfDay <= EFECTY_WINDOW_END_MINUTE;

  if (
    Number.isFinite(minute) &&
    minute % EFECTY_INTERVAL_MINUTES === 0 &&
    isEfectyWindow
  ) {
    tasks.push("efecty");
  }

  const isMoraWindow =
    minuteOfDay >= MORA_WINDOW_START_MINUTE ||
    minuteOfDay <= MORA_WINDOW_END_MINUTE;

  if (
    Number.isFinite(minute) &&
    minute % MORA_INTERVAL_MINUTES === 0 &&
    isMoraWindow
  ) {
    tasks.push("mora");
  }

  return tasks;
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

  for (const key of ["ok", "generatedAt", "selection", "summary", "today"]) {
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
      today: moraEffectiveDate,
    });
    logCron("Mora y bloqueos finalizados.", summarizeReport(result));
    completed = true;
  } catch (error) {
    console.error(
      `[finserpay-cron] Fallo ${taskName}:`,
      error instanceof Error ? error.message : error,
    );
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
  const dueTasks = getDueTasks(timeKey);
  const moraEffectiveDate = getMoraEffectiveDate(dateKey, timeKey);

  for (const taskName of dueTasks) {
    await runScheduledTask(
      taskName,
      `${taskName}:${dateKey}:${timeKey}`,
      taskName === "mora" ? moraEffectiveDate : undefined,
    );
  }
}

async function runStartupRecovery() {
  const { dateKey, timeKey } = getBogotaClock();
  const moraEffectiveDate = getMoraEffectiveDate(dateKey, timeKey);

  await runScheduledTask("wompi", `wompi:startup-recovery:${dateKey}`);
  await runScheduledTask("efecty", `efecty:startup-recovery:${dateKey}`);
  await runScheduledTask(
    "mora",
    `mora:startup-recovery:${moraEffectiveDate}`,
    moraEffectiveDate,
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
    "Programacion interna activa: Wompi cada 5 minutos, Efecty cada 10 minutos entre 23:10 y 01:50, mora cada 10 minutos entre 23:30 y 01:50, con recuperacion al iniciar, hora Colombia.",
  );

  void runStartupRecovery();
}
