import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { paymentReminder } = await jiti.import("../app/clientes/credit-dashboard-presentation.ts");

test("el recordatorio cuenta días de calendario en Colombia, incluso cerca de medianoche UTC", () => {
  assert.equal(paymentReminder("2026-10-02", false, new Date("2026-09-17T04:59:59Z")), "Próximo pago en 16 días");
  assert.equal(paymentReminder("2026-10-02", false, new Date("2026-09-17T05:00:00Z")), "Próximo pago en 15 días");
});
test("la cuota de hoy y mañana tiene texto preciso y no se convierte en mora localmente", () => {
  const now = new Date("2026-09-16T20:00:00-05:00");
  assert.equal(paymentReminder("2026-09-16", false, now), "Tu próximo pago es hoy");
  assert.equal(paymentReminder("2026-09-17", false, now), "Próximo pago en 1 día");
  assert.equal(paymentReminder("2026-09-15", false, now), "Consulta el estado de tu próxima cuota");
});
test("mora usa el estado del servidor y las fechas ausentes no inventan vencimientos", () => {
  assert.equal(paymentReminder("2026-12-01", true), "Paga hoy y evita cargos adicionales");
  assert.equal(paymentReminder(null, false), "No tienes cuotas pendientes");
  assert.equal(paymentReminder("fecha inválida", false), "Fecha por confirmar");
});
