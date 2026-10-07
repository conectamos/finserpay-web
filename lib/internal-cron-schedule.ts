const EFECTY_INTERVAL_MINUTES = 10;
const EFECTY_WINDOW_START_MINUTE = 23 * 60 + 10;
const EFECTY_WINDOW_END_MINUTE = 1 * 60 + 50;
const MORA_INTERVAL_MINUTES = 10;
const MORA_WINDOW_START_MINUTE = 23 * 60 + 30;
const MORA_WINDOW_END_MINUTE = 1 * 60 + 50;
const WOMPI_INTERVAL_MINUTES = 5;

export type InternalCronTask = "efecty" | "mora" | "unlock" | "wompi" | "credit-due-reminders" | "credit-due-today-reminders";

export function isCreditReminderTask(task: string): task is "credit-due-reminders" | "credit-due-today-reminders" {
  return task === "credit-due-reminders" || task === "credit-due-today-reminders";
}

export function getDueInternalCronTasks(timeKey: string) {
  const tasks: InternalCronTask[] = [];
  const [hourValue = "", minuteValue = ""] = timeKey.split(":");
  const hour = Number.parseInt(hourValue, 10);
  const minute = Number.parseInt(minuteValue, 10);
  const minuteOfDay = hour * 60 + minute;

  if (Number.isFinite(minute) && minute % WOMPI_INTERVAL_MINUTES === 0) {
    tasks.push("wompi");
  }

  // Run once each Colombian day, with recovery during the following hour.
  // Durable credit/installment reservations also protect restarts and replicas.
  if (hour === 10 && minute >= 0 && minute < 60) {
    tasks.push("credit-due-reminders", "credit-due-today-reminders");
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

export function getStartupRecoveryTasks(timeKey: string) {
  return [
    "wompi" as const,
    ...getDueInternalCronTasks(timeKey).filter(
      (taskName): taskName is "efecty" | "mora" | "credit-due-reminders" | "credit-due-today-reminders" =>
        taskName === "efecty" || taskName === "mora" || isCreditReminderTask(taskName),
    ),
  ];
}
