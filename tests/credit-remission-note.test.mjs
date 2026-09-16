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
  assert.match(
    source.slice(remediation, internalControls),
    /autoOpen=\{activeFactoryStepNumber === 4\}/,
  );
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
  assert.match(source, /Imprimir o guardar PDF/);
  assert.match(source, /preload[\s\S]*unoptimized/);
  assert.match(source, /No fue posible cargar el logo/);
  assert.doesNotMatch(source, /\bpriority\b/);
  assert.doesNotMatch(source, />\$0</);
});

test("abre un diálogo accesible para descargar la remisión al llegar al paso 4", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-remission-note.tsx",
  );

  assert.match(source, /useState\(false\)/);
  assert.match(source, /window\.sessionStorage\.getItem\(remissionSessionKey\)/);
  assert.match(source, /setDownloadDialogOpen\(true\)/);
  assert.match(source, /window\.sessionStorage\.setItem\(remissionSessionKey, "confirmed"\)/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby=\{downloadDialogTitleId\}/);
  assert.match(source, /aria-describedby=\{downloadDialogDescriptionId\}/);
  assert.match(source, /event\.key === "Escape"[\s\S]*if \(printInvoked\)/);
  assert.match(source, /document\.body\.style\.overflow = "hidden"/);
  assert.match(source, /element\.inert = true/);
  assert.match(source, /element\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(source, /state\.element\.inert = state\.inert/);
  assert.match(source, /Antes de continuar/);
  assert.match(source, /Descargue e imprima la remisión del cliente\./);
  assert.match(source, /El cliente debe firmar como en la cédula\./);
  assert.match(source, /Descargar remisión/);
  assert.match(source, /Generando remisión…/);
  assert.match(source, /Remisión descargada/);
  assert.match(source, /Cerrar y continuar/);
  assert.match(source, /Se habilitará después de descargar la remisión\./);
  assert.match(source, /disabled=\{!printInvoked\}/);
  assert.match(source, /step-four-remission-phone\.png/);
  assert.match(
    source,
    /<FinserBrand[\s\S]*accentFinser[\s\S]*showTagline=\{false\}[\s\S]*wordmarkOnly/,
  );
  assert.match(source, /setPrintInvoked\(true\)[\s\S]*window\.print\(\)/);
  assert.doesNotMatch(source, /onMouseDown=\{\(\) => setDownloadDialogOpen\(false\)\}/);
  assert.doesNotMatch(
    source.slice(0, source.indexOf("const handlePrint")),
    /window\.print\(\)/,
    "La apertura automática no debe lanzar la impresión sin un gesto del asesor",
  );
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
  assert.match(css, /backdrop-filter:\s*blur\(6px\)/);
  assert.match(css, /width:\s*min\(100%, 37rem\)/);
  assert.match(css, /border-radius:\s*14px/);
  assert.match(css, /background:\s*#fffaf2/);
  assert.match(css, /background:\s*#359523/);
  assert.match(
    css,
    /@font-face\s*{[\s\S]*Finser Remission Wordmark[\s\S]*Geist-Regular\.ttf/,
  );
  assert.match(
    css,
    /\.dialogBrand p\s*{[\s\S]*color:\s*#359523 !important[\s\S]*Finser Remission Wordmark[\s\S]*font-size:\s*1\.75rem[\s\S]*font-weight:\s*700 !important/,
  );
  assert.match(css, /\.dialogBrand p span\s*{[\s\S]*color:\s*#ffffff !important/);
  assert.match(css, /\.dialogWave\s*{[\s\S]*bottom:\s*-1\.8rem/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
