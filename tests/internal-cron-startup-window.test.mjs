import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { getStartupRecoveryTasks } = await jiti.import(
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
