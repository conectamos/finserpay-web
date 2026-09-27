import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import ts from "typescript";
import RealPDFDocument from "pdfkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: {
  "@": projectRoot,
  "server-only": path.join(projectRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
} });
const { buildCreditPazYSalvoPdf, getCreditPazYSalvoPdfErrorCode } = await jiti.import("../lib/credit-paz-y-salvo-pdf.ts");
const normalize = value => String(value).replace(/\s+/g, " ").trim();

function input(overrides = {}) {
  return {
    folio: "FC-CONTRATO-31", numeroCreditoVisible: "000031-A",
    clienteNombre: "María Fernanda Gómez Pérez", clienteDocumento: "00123456789",
    sedeNombre: "Sede comercial norte", equipo: "INFINIX SMART 20 128GB",
    imei: "350000000000031", deviceUid: "DEVICE-UID-REAL-31",
    estado: "PAZ_Y_SALVO", deliverableLabel: "Entrega verificada",
    issuedAt: new Date("2026-09-26T03:15:00.000Z"), issuer: "Administradora de sede",
    referenciaPago: "REF-PAGO-31", ...overrides,
  };
}

async function readPdf(buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const pdf = await loading.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(item => normalize(item.str)).map(item => ({
        text: normalize(item.str), x: item.transform[4], y: viewport.height - item.transform[5],
        width: item.width, height: item.height, font: content.styles[item.fontName]?.fontFamily,
      }));
      pages.push({ number, width: viewport.width, height: viewport.height, items,
        text: normalize(items.map(item => item.text).join(" ")) });
    }
    return { pages, text: normalize(pages.map(page => page.text).join(" ")),
      title: (await pdf.getMetadata()).info.Title };
  } finally { await loading.destroy(); }
}

function assertPrintLayout(content) {
  for (const page of content.pages) {
    assert.ok(Math.abs(page.width - 595.28) < 1 && Math.abs(page.height - 841.89) < 1, "the certificate is A4");
    assert.ok(page.items.every(item => item.x >= 47 && item.x + item.width <= page.width - 47
      && item.y >= 47 && item.y <= page.height - 47), `page ${page.number} stays inside printable margins`);
    assert.ok(page.items.every(item => item.height >= 8.99), "traceability remains readable when printed");
    assert.match(page.text, /Certificado de paz y salvo/, "each page retains the certificate identity");
    assert.match(page.text, /FINSER PAY S\.A\.S\. \| NIT 902052909-4 \| Ibagué, Tolima/, "the original business identity remains on every page");
    assert.match(page.text, new RegExp(`Página ${page.number} de ${content.pages.length}`));
    assert.doesNotMatch(page.text, /\.\.\.|…/);
    const footer = page.items.find(item => item.text.startsWith("FINSER PAY S.A.S. | NIT"));
    const body = page.items.filter(item => item.y > 180 && item.y < footer.y - 12);
    assert.ok(body.length > 0, "no continuation page exists only for a footer");
    assert.ok(body.every(item => item.y + item.height < footer.y - 12), "body cannot collide with the footer");
  }
}

test("a paid certificate fits one formal A4 page and preserves every real identity and trace field", async () => {
  const data = input();
  const before = structuredClone(data);
  const content = await readPdf(await buildCreditPazYSalvoPdf(data));
  assert.equal(content.pages.length, 1);
  assert.equal(content.title, "Paz y salvo 000031-A");
  for (const value of [data.clienteNombre, data.clienteDocumento, data.numeroCreditoVisible,
    data.folio, data.equipo, data.imei, data.deviceUid, data.sedeNombre, data.issuer,
    data.referenciaPago, data.deliverableLabel]) {
    assert.ok(content.text.includes(value), `the actual field is complete: ${value}`);
  }
  assert.match(content.text, /Folio original: FC-CONTRATO-31/);
  assert.match(content.text, /25 de septiembre de 2026/);
  assert.match(content.text, /10:15/);
  assert.match(content.text, /ha pagado en su totalidad el crédito 000031-A/);
  assert.match(content.text, /no presenta saldo pendiente por esta obligación/);
  assert.match(content.text, /OBLIGACIÓN CUMPLIDA/);
  assert.match(content.text, /Emisor del certificado/);
  const title = content.pages[0].items.find(item => item.text === "Certificado de paz y salvo");
  assert.ok(title.height >= 26.9 && title.font === "serif", "the formal title uses a legible serif face");
  assertPrintLayout(content);
  assert.deepEqual(data, before, "generating the document cannot alter the credit or issuance data");
});

test("long names, equipment and traceability wrap into complete continuation pages without ellipsis", async () => {
  const data = input({
    clienteNombre: Array.from({ length: 28 }, (_, index) => `APELLIDO${index + 1}`).join(" "),
    equipo: Array.from({ length: 45 }, (_, index) => `REFERENCIA${index + 1}`).join(" "),
    sedeNombre: Array.from({ length: 35 }, (_, index) => `SEDE${index + 1}`).join(" "),
    issuer: Array.from({ length: 35 }, (_, index) => `EMISOR${index + 1}`).join(" "),
    referenciaPago: "REFERENCIA-" + "1234567890".repeat(14),
    deviceUid: "DEVICE-" + "ABCDEFGH".repeat(18),
  });
  const before = structuredClone(data);
  const content = await readPdf(await buildCreditPazYSalvoPdf(data));
  assert.ok(content.pages.length >= 2, "the fixture actually crosses a page boundary");
  for (const value of [data.clienteNombre, data.equipo, data.sedeNombre, data.issuer]) {
    assert.ok(content.text.includes(value), "complete multiword values survive wrapping");
  }
  for (const value of [data.referenciaPago, data.deviceUid]) {
    assert.ok(content.text.replace(/\s/g, "").includes(value), "every character of unbroken identifiers survives wrapping");
  }
  assertPrintLayout(content);
  assert.deepEqual(data, before);
});

test("legacy credits keep their original folio and omit unavailable device or delivery facts", async () => {
  const data = input({ numeroCreditoVisible: undefined, imei: null, deviceUid: null,
    deliverableLabel: null, equipo: null, estado: null, referenciaPago: null });
  const content = await readPdf(await buildCreditPazYSalvoPdf(data));
  assert.equal(content.title, "Paz y salvo FC-CONTRATO-31");
  assert.match(content.text, /crédito FC-CONTRATO-31/);
  assert.doesNotMatch(content.text, /Folio original:|Device UID|IMEI|Entregabilidad|Entrega verificada|Sin verificacion/);
  assert.match(content.text, /Estado actual Paz y salvo/);
  assert.doesNotMatch(content.text.toLowerCase(), /desbloqueado|liberado|desbloqueo completado/);
  assertPrintLayout(content);
});

test("the certificate reports actual device delivery status without claiming an unperformed unlock", async () => {
  const data = input({ estado: "DESBLOQUEO_PENDIENTE", deliverableLabel: "Pendiente de verificación tecnológica" });
  const content = await readPdf(await buildCreditPazYSalvoPdf(data));
  assert.match(content.text, /Estado actual Desbloqueo Pendiente/);
  assert.match(content.text, /Pendiente de verificación tecnológica/);
  assert.doesNotMatch(content.text.toLowerCase(), /equipo desbloqueado|equipo liberado|desbloqueo completado/);
  assert.match(content.text, /no presenta saldo pendiente por esta obligación/);
  assertPrintLayout(content);
});

test("an unavailable issuance date stays unavailable instead of fabricating today's date", async () => {
  const content = await readPdf(await buildCreditPazYSalvoPdf(input({ issuedAt: new Date("invalid") })));
  assert.match(content.text, /Fecha de expedición: -/);
  assert.doesNotMatch(content.text, /NaN|Invalid Date/);
  assertPrintLayout(content);
});

test("a failed brand font retries with safe built-in fonts while retaining the actual certificate", async () => {
  const require = createRequire(import.meta.url);
  const source = fs.readFileSync(path.join(projectRoot, "lib/credit-paz-y-salvo-pdf.ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const attempts = [];
  class FontFailureOnce extends RealPDFDocument {
    constructor(options) {
      attempts.push(options.font);
      if (attempts.length === 1) throw new Error("font unavailable");
      super(options);
    }
  }
  const exports = {};
  vm.runInNewContext(code, { exports, Buffer, process,
    console: { error() {} },
    require(specifier) {
      if (specifier === "server-only") return {};
      if (specifier === "pdfkit") return FontFailureOnce;
      if (specifier === "node:fs") return { existsSync: () => true };
      if (specifier === "@/lib/credit-display-number") return {
        creditDisplayNumber: value => value.numeroCreditoVisible?.trim() || value.folio?.trim() || "Sin folio",
      };
      return require(specifier);
    },
  }, { filename: "credit-paz-y-salvo-pdf.ts" });
  const content = await readPdf(await exports.buildCreditPazYSalvoPdf(input()));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0], "Helvetica");
  assert.equal(attempts[1], "Helvetica");
  assert.match(content.text, /María Fernanda Gómez Pérez/);
  assert.match(content.text, /REF-PAGO-31/);
  assertPrintLayout(content);
});

test("typed rendering errors stay restricted to the supported PDF error codes", () => {
  assert.equal(getCreditPazYSalvoPdfErrorCode(new Error("PYS_PDF_FONTS")), "PYS_PDF_FONTS");
  assert.equal(getCreditPazYSalvoPdfErrorCode(new Error("PYS_PDF_FINALIZE")), "PYS_PDF_FINALIZE");
  for (const value of [new Error("database unavailable"), new Error("PYS_PDF_FONTS details"),
    { message: "PYS_PDF_FONTS" }, null, "PYS_PDF_FONTS"]) {
    assert.equal(getCreditPazYSalvoPdfErrorCode(value), null);
  }
});