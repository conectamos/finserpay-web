import { syncAllCreditMora } from "@/lib/credit-mora-sync";
import { syncEfectyRecaudosFromSftp } from "@/lib/efecty-recaudos";
import { reconcilePendingWompiPayments } from "@/lib/wompi-reconciliation";

const BOGOTA_TIME_ZONE = "America/Bogota";
const CHECK_INTERVAL_MS = 30_000;
const EFECTY_TIMES = new Set(["23:15", "23:25", "23:35", "23:45"]);
const MORA_TIMES = new Set(["23:30"]);
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

function getDueTasks(timeKey: string) {
  const tasks: InternalCronTask[] = [];
  const [, minuteValue = ""] = timeKey.split(":");
  const minute = Number.parseInt(minuteValue, 10);

  if (Number.isFinite(minute) && minute % WOMPI_INTERVAL_MINUTES === 0) {
    tasks.push("wompi");
  }

  if (EFECTY_TIMES.has(timeKey)) {
    tasks.push("efecty");
  }

  if (MORA_TIMES.has(timeKey)) {
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

async function runScheduledTask(taskName: InternalCronTask, runKey: string) {
  const state = getState();

  if (state.running.has(runKey) || state.completed.has(runKey)) {
    return;
  }

  state.running.add(runKey);
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
        includePreviousFiles: false,
        limitFiles: 10,
      });
      logCron("Recaudos Efecty finalizados.", summarizeReport(result));
      completed = true;
      return;
    }

    logCron("Ejecutando mora y bloqueos.");
    const result = await syncAllCreditMora({ dryRun: false });
    logCron("Mora y bloqueos finalizados.", summarizeReport(result));
    completed = true;
  } catch (error) {
    console.error(
      `[finserpay-cron] Fallo ${taskName}:`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    state.running.delete(runKey);

    if (completed) {
      state.completed.add(runKey);
    }

    if (state.completed.size > 200) {
      state.completed.clear();
    }
  }
}

async function tick() {
  const { dateKey, timeKey } = getBogotaClock();
  const dueTasks = getDueTasks(timeKey);

  for (const taskName of dueTasks) {
    await runScheduledTask(taskName, `${taskName}:${dateKey}:${timeKey}`);
  }
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
    "Programacion interna activa: Wompi cada 5 minutos, Efecty 23:15/23:25/23:35/23:45, mora 23:30, hora Colombia.",
  );

  void tick();
}
