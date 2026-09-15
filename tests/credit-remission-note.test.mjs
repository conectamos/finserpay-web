import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatCreditRemissionCurrency,
  formatCreditRemissionDate,
  getCreditRemissionPaymentSchedule,
  isCreditRemissionReady,
} from "../lib/credit-remission.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

const completeRemission = {
  clienteNombre: "MARÍA JOSÉ NÚÑEZ",
  clienteDocumento: "1105616341",
  referenciaEquipo: "IPHONE 13 PRO 256GB",
  valorVenta: 2_600_000,
  valorInicial: 780_000,
  numeroCuotas: 40,
  valorCuota: 90_850,
  fechaPrimerPago: "2026-10-02",
};

test("formatea la fecha civil del primer pago sin retroceder por zona horaria", () => {
  assert.equal(formatCreditRemissionDate("2026-10-02"), "02/10/2026");
  assert.equal(
    formatCreditRemissionDate(new Date("2026-09-15T04:30:00.000Z")),
    "14/09/2026",
  );
  assert.equal(formatCreditRemissionDate("2026-02-30"), "Pendiente");
});

test("presenta valores COP y periodicidad según la política del crédito", () => {
  assert.match(
    formatCreditRemissionCurrency(2_600_000).replace(/\s/g, " "),
    /^\$\s*2\.600\.000$/,
  );
  assert.equal(
    getCreditRemissionPaymentSchedule("QUINCENAL", "2026-10-02"),
    "02 y 17 de cada mes",
  );
  assert.equal(
    getCreditRemissionPaymentSchedule("MENSUAL", "2026-10-17"),
    "Día 17 de cada mes",
  );
  assert.equal(
    getCreditRemissionPaymentSchedule("SEMANAL", "2026-10-02"),
    "Cada 7 días",
  );
  assert.equal(
    getCreditRemissionPaymentSchedule("CATORCENAL", "2026-10-02"),
    "Cada 14 días",
  );
});

test("habilita la remisión solo cuando todos los datos imprimibles son válidos", () => {
  assert.equal(isCreditRemissionReady(completeRemission), true);
  assert.equal(
    isCreditRemissionReady({ ...completeRemission, clienteDocumento: "" }),
    false,
  );
  assert.equal(
    isCreditRemissionReady({ ...completeRemission, valorCuota: 0 }),
    false,
  );
  assert.equal(
    isCreditRemissionReady({ ...completeRemission, fechaPrimerPago: "2026-02-30" }),
    false,
  );
  assert.equal(
    isCreditRemissionReady({ ...completeRemission, valorInicial: 0 }),
    true,
  );
});

test("el paso 4 visible usa la remisión con la cuota pactada y los datos del crédito", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx",
  );
  const deliveryStart = source.indexOf("{wizardStep === 5 && (");
  const remediation = source.indexOf("<CreditRemissionNote", deliveryStart);
  const internalControls = source.indexOf("{canSeeInternalPricing &&", remediation);

  assert.ok(deliveryStart >= 0, "Debe existir el paso de entrega");
  assert.ok(remediation > deliveryStart, "La remisión debe estar dentro del paso 4 visible");
  assert.ok(internalControls > remediation, "La remisión debe aparecer antes de los controles de entrega");
  assert.match(source.slice(remediation, internalControls), /valorCuota=\{valorCuotaPactada\}/);
  assert.match(source.slice(remediation, internalControls), /valorVenta=\{valorTotalEquipoNumero\}/);
  assert.match(source.slice(remediation, internalControls), /valorInicial=\{cuotaInicialNumero\}/);
  assert.match(source.slice(remediation, internalControls), /clienteDocumento=\{clienteDocumento\}/);
  assert.match(source.slice(remediation, internalControls), /fechaPrimerPago=\{fechaPrimerPago\}/);
});

test("la hoja contiene el logo, todos los campos, firma, huella y notas legales", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-remission-note.tsx",
  );

  for (const text of [
    "/branding/finserpay-logo.jpg",
    "Fecha de impresión",
    "Nombre",
    "Documento / CC",
    "Referencia",
    "FINSERPAY",
    "Valor venta",
    "Valor inicial",
    "N.º cuotas",
    "Valor cuota",
    "Fechas de pago",
    "Primer pago",
    "Firma del cliente",
    "Huella",
    "no incluye costos de financiación",
    "manifiesto mi conformidad y aceptación",
  ]) {
    assert.ok(source.includes(text), `Falta el contenido: ${text}`);
  }

  assert.match(source, /flushSync[\s\S]*setPrintedAt\(new Date\(\)\)/);
  assert.match(source, /window\.requestAnimationFrame\([\s\S]*window\.print\(\)/);
  assert.match(source, /<Button type="button"[\s\S]*Imprimir nota de remisión/);
  assert.match(source, /preload[\s\S]*unoptimized/);
  assert.match(source, /No fue posible cargar el logo/);
  assert.doesNotMatch(source, /\bpriority\b/);
  assert.doesNotMatch(source, />\$0</);
});

test("la impresión aísla una hoja A4 y conserva colores y bloques completos", async () => {
  const css = await readProjectFile(
    "app/dashboard/creditos/credit-remission-note.module.css",
  );

  assert.match(css, /@page\s*{[\s\S]*size:\s*A4 portrait/);
  assert.match(css, /@media print/);
  assert.match(css, /body\.fp-remission-printing/);
  assert.match(css, /fp-remission-print-root/);
  assert.match(css, /print-color-adjust:\s*exact/);
  assert.match(css, /break-inside:\s*avoid/);
});
