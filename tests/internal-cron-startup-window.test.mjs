import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { getStartupRecoveryTasks, getDueInternalCronTasks } = await jiti.import(
  "../lib/internal-cron-schedule.ts"
);

test("el arranque diurno no dispara sincronizaciones nocturnas pesadas", () => {
  assert.deepEqual(getStartupRecoveryTasks("16:20"), ["wompi"]);
});

test("el arranque nocturno conserva Efecty y mora dentro de sus ventanas", () => {
  assert.deepEqual(getStartupRecoveryTasks("23:20"), ["wompi", "efecty"]);
  assert.deepEqual(getStartupRecoveryTasks("23:40"), [
    "wompi",
    "efecty",
    "mora",
  ]);
  assert.deepEqual(getStartupRecoveryTasks("00:40"), [
    "wompi",
    "efecty",
    "mora",
  ]);
  assert.deepEqual(getStartupRecoveryTasks("02:00"), ["wompi"]);
});

test("recordatorios solo arrancan y se recuperan de 10:00 a 10:59 Colombia", () => {
  for (const time of ["09:59", "11:00", "16:20", "23:40"]) {
    assert.equal(getDueInternalCronTasks(time).includes("credit-due-reminders"), false);
    assert.equal(getStartupRecoveryTasks(time).includes("credit-due-reminders"), false);
  }
  for (const time of ["10:00", "10:01", "10:59"]) {
    assert.equal(getDueInternalCronTasks(time).includes("credit-due-reminders"), true);
    assert.equal(getStartupRecoveryTasks(time).includes("credit-due-reminders"), true);
  }
});
