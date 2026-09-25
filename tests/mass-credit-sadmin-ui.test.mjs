import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import ExcelJS from "exceljs";
import * as spreadsheet from "../lib/mass-credit-spreadsheet.ts";

const source = readFileSync(new URL("../app/dashboard/creditos-masivos/mass-credit-import-console.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const ui = new Proxy({}, { get: (_, key) => String(key) });
const jsx = (type, props) => ({ type, props });
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children), ...nodes(node.props?.actions)] : [];
const content = node => Array.isArray(node) ? node.map(content).join("") : typeof node === "string" || typeof node === "number" ? String(node) : content(node?.props?.children ?? "");
function mount(fetch) {
  const slots = []; let index = 0, dirty = true, effects = [], tree;
  const downloads = [];
  const hooks = {
    useState(initial) { const i = index++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === "function" ? value(slots[i].value) : value; dirty = true; }]; },
    useRef(value) { const i = index++; return slots[i] ??= { current: value }; },
    useMemo(compute) { return compute(); }, useCallback(callback) { return callback; },
    useEffect(effect) { const i = index++; if (!slots[i]) { slots[i] = {}; effects.push(effect); } },
  };
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, fetch, console, Blob, Intl, Date, Error, crypto: { randomUUID },
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:fixture"; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) },
    require(name) {
      if (name === "@/lib/mass-credit-spreadsheet") return { ...spreadsheet, buildMassCreditWorkbook: (headers, example) => spreadsheet.buildMassCreditWorkbook([...headers], [...example]) };
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return ui;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
      throw new Error(name);
    },
  });
  return {
    async flush() { for (let cycle = 0; cycle < 30; cycle++) {
      if (dirty) { dirty = false; index = 0; effects = []; tree = loaded.exports.default(); for (const effect of effects) effect(); }
      await setImmediate(); if (!dirty) return;
    } throw new Error("UI did not settle"); },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, "Expected rendered control"); return node; },
    text: () => content(tree), downloads,
  };
}
const button = (h, label) => h.find(node => ["Button", "button"].includes(node.type) && content(node).trim() === label);
const catalog = { aliados: [{ id: 2, nombre: "ALIADO" }], sedes: [{ id: 2, aliadoId: 2, nombre: "SEDE" }], vendedores: [{ id: 1, sedeId: 2, nombre: "VENDEDOR" }] };
const preview = rows => ({ ok: true, commit: false, rows: rows.map((row, i) => ({ normalized: { ...row }, rowNumber: i + 1, ok: true, errors: [], warnings: [] })), summary: { total: rows.length, valid: rows.length, invalid: 0, warnings: 0 } });
const created = rows => { const result = preview(rows); return { ...result, commit: true, created: rows.length, summary: { ...result.summary, created: rows.length }, rows: result.rows.map((row, i) => ({ ...row, createdCreditoId: i + 1, createdFolio: `FC-${i + 1}` })) }; };
async function upload(h, csv) {
  h.find(node => node.type === "input" && node.props.type === "file").props.onChange({ target: { files: [{ name: "prueba.csv", size: csv.length, text: async () => csv }], value: "" } });
  await h.flush();
}
const csv = "FECHA;CEDULA;CLIENTE;TELEFONO;REFERENCIA;IMEI;ALIADO;SEDE;VENDEDOR;INICIAL;VALOR DEL CREDITO;CUOTA;PLAZO;FRECUENCIA;FECHA DE PAGO;Número de crédito en SADMIN\n2026-09-01;900001;CLIENTE;3001234567;EQUIPO;490154203237518;ALIADO;SEDE;VENDEDOR;0;600000;60000;12;CATORCENAL;2026-09-15;000ABC";

test("CSV template and preview preserve number; failed save offers retry with same ID and explicit confirmation", async () => {
  const requests = []; let fail = true;
  const h = mount(async (_url, options) => {
    if (!options?.body) return Response.json(catalog);
    const body = JSON.parse(options.body); requests.push(body);
    if (body.commit && fail) { fail = false; throw new Error("Error de conexión: reintenta"); }
    return Response.json(body.commit ? created(body.rows) : preview(body.rows));
  });
  await h.flush(); button(h, "Descargar plantilla CSV").props.onClick();
  assert.match(await h.downloads[0].text(), /Número de crédito en SADMIN/);
  await upload(h, csv); button(h, "Validar archivo").props.onClick(); await h.flush();
  assert.equal(requests[0].rows[0].numeroCreditoSadmin, "000ABC");
  assert.match(h.text(), /000ABC/);
  button(h, "Crear creditos").props.onClick(); await h.flush();
  let dialog = h.find(node => node.type === "ConfirmDialog");
  assert.equal(dialog.props.open, true); assert.match(dialog.props.description, /ya existen en SADMIN/);
  dialog.props.onConfirm(); await h.flush();
  assert.match(h.text(), /Error de conexión/); assert.ok(button(h, "Reintentar guardado"));
  button(h, "Reintentar guardado").props.onClick(); await h.flush();
  h.find(node => node.type === "ConfirmDialog").props.onConfirm(); await h.flush();
  assert.equal(requests[1].requestId, requests[2].requestId);
  assert.equal(requests[2].sadminConfirmed, true);
  assert.match(h.text(), /1 crédito\(s\) creados con su número SADMIN confirmado/);
});

test("individual exposes field and posts it through preview and creation; server revalidation errors never show success", async () => {
  const requests = []; let rejectCommit = true;
  const h = mount(async (_url, options) => {
    if (!options?.body) return Response.json(catalog);
    const body = JSON.parse(options.body); requests.push(body); const result = preview(body.rows);
    if (body.commit && rejectCommit) return Response.json({ ...result, ok: false, rows: result.rows.map(row => ({ ...row, ok: false, errors: ["Esta cédula ya tiene un crédito"] })), summary: { ...result.summary, invalid: 1, valid: 0 } });
    return Response.json(body.commit ? created(body.rows) : result);
  });
  await h.flush(); button(h, "Credito individual").props.onClick(); await h.flush();
  const field = h.find(node => node.props?.label === "Número de crédito en SADMIN");
  field.props.onChange("000INDIVIDUAL"); await h.flush();
  button(h, "Validar credito").props.onClick(); await h.flush();
  button(h, "Crear credito").props.onClick(); await h.flush();
  h.find(node => node.type === "ConfirmDialog").props.onConfirm(); await h.flush();
  assert.equal(requests[0].rows.length, 1); assert.equal(requests[0].rows[0].numeroCreditoSadmin, "000INDIVIDUAL");
  assert.match(h.text(), /No se creó ningún crédito/); assert.match(h.text(), /ya tiene un crédito/);
  assert.equal(button(h, "Crear credito").props.disabled, true);
  rejectCommit = false;
  h.find(node => node.props?.label === "Número de crédito en SADMIN").props.onChange("000INDIVIDUAL2"); await h.flush();
  button(h, "Validar credito").props.onClick(); await h.flush();
  button(h, "Crear credito").props.onClick(); await h.flush();
  h.find(node => node.type === "ConfirmDialog").props.onConfirm(); await h.flush();
  assert.match(h.text(), /1 crédito\(s\) creados/);
  assert.equal(requests.at(-1).rows[0].numeroCreditoSadmin, "000INDIVIDUAL2");
});

async function waitFor(h, predicate) {
  for (let n = 0; n < 300; n++) {
    await h.flush();
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("La operación de archivo no terminó");
}

test("Excel template helps prepare CSV with exact IMEI and leading zeros through preview and creation", async () => {
  const requests = [];
  const h = mount(async (_url, options) => {
    if (!options?.body) return Response.json(catalog);
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json(body.commit ? created(body.rows) : preview(body.rows));
  });
  await h.flush();
  button(h, "Plantilla Excel para CSV").props.onClick();
  await waitFor(h, () => h.downloads.length === 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await h.downloads[0].arrayBuffer());
  const sheet = workbook.getWorksheet("Creditos");
  assert.equal(sheet.getCell("F2").type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("F2").numFmt, "@");
  assert.equal(sheet.getCell("F251").numFmt, "@");
  sheet.getCell("F2").value = "001234567890128";
  sheet.getCell("P2").value = "00000123";
  // CSV UTF-8 exported from Excel's text cells retains the original characters.
  const csvFromExcel = ["FECHA;CEDULA;CLIENTE;TELEFONO;REFERENCIA;IMEI;ALIADO;SEDE;VENDEDOR;INICIAL;VALOR DEL CREDITO;CUOTA;PLAZO;FRECUENCIA;FECHA DE PAGO;Número de crédito en SADMIN",
    sheet.getRow(2).values.slice(1).join(";")].join("\n");
  await upload(h, csvFromExcel);
  await waitFor(h, () => h.text().includes("prueba.csv cargado correctamente"));
  button(h, "Validar archivo").props.onClick(); await h.flush();
  assert.equal(requests[0].rows[0].imei, "001234567890128");
  assert.equal(requests[0].rows[0].numeroCreditoSadmin, "00000123");
  assert.match(h.text(), /001234567890128/);
  button(h, "Crear creditos").props.onClick(); await h.flush();
  h.find(n => n.type === "ConfirmDialog").props.onConfirm(); await h.flush();
  assert.equal(requests[1].rows[0].imei, "001234567890128");
  assert.equal(requests[1].sadminConfirmed, true);
});

test("rejects an Excel file at upload with clear CSV instructions", async () => {
  const h = mount(async () => Response.json(catalog)); await h.flush();
  h.find(n => n.type === "input" && n.props.type === "file").props.onChange({ target: {
    files: [{ name: "datos.xlsx", size: 4, text: async () => "" }], value: "",
  } });
  await h.flush();
  assert.match(h.text(), /CSV UTF-8/);
  assert.equal(button(h, "Validar archivo").props.disabled, true);
});

test("CSV with scientific IMEI shows its row error and blocks creation", async () => {
  const h = mount(async (_url, options) => {
    if (!options?.body) return Response.json(catalog);
    const row = JSON.parse(options.body).rows[0];
    return Response.json({ ok: false, commit: false, rows: [{ normalized: row, rowNumber: 1, ok: false,
      errors: ["IMEI en notación científica. Recupera los 15 dígitos originales."], warnings: [] }],
      summary: { total: 1, valid: 0, invalid: 1, warnings: 0 } });
  });
  await h.flush(); await upload(h, csv.replace("490154203237518", "1E+15"));
  button(h, "Validar archivo").props.onClick(); await h.flush();
  assert.match(h.text(), /IMEI en notación científica/);
  assert.equal(button(h, "Crear creditos").props.disabled, true);
});


test("temporary-IMEI confirmation is CSV-only and persists from revalidation through confirmed creation", async () => {
  const requests = [];
  const h = mount(async (_url, options) => {
    if (!options?.body) return Response.json(catalog);
    const body = JSON.parse(options.body);
    requests.push(body);
    return Response.json(body.commit ? created(body.rows) : preview(body.rows));
  });
  await h.flush();
  assert.match(h.text(), /Registrar lote histórico con IMEI temporales/);
  button(h, "Credito individual").props.onClick(); await h.flush();
  assert.doesNotMatch(h.text(), /Registrar lote histórico con IMEI temporales/);
  button(h, "Carga de archivo").props.onClick(); await h.flush();

  const [header, first] = csv.split("\n");
  const second = first.replace("900001", "900002").replace("490154203237518", "100000000000001").replace("000ABC", "000DEF");
  await upload(h, [header, first.replace("490154203237518", "100000000000000"), second].join("\n"));
  button(h, "Validar archivo").props.onClick(); await h.flush();
  assert.equal(requests[0].temporaryImeiConfirmed, false);
  assert.equal(button(h, "Crear creditos").props.disabled, false);

  const label = h.find(node => node.type === "label" && content(node).includes("Registrar lote histórico con IMEI temporales"));
  const checkbox = nodes(label).find(node => node.type === "input" && node.props.type === "checkbox");
  assert.ok(checkbox);
  checkbox.props.onChange({ target: { checked: true } }); await h.flush();
  assert.equal(button(h, "Crear creditos").props.disabled, true);
  assert.match(h.text(), /Vuelve a validar el archivo/);

  button(h, "Validar archivo").props.onClick(); await h.flush();
  assert.equal(requests[1].temporaryImeiConfirmed, true);
  assert.equal(requests[1].rows.length, 2);
  assert.equal(button(h, "Crear creditos").props.disabled, false);
  button(h, "Crear creditos").props.onClick(); await h.flush();
  const dialog = h.find(node => node.type === "ConfirmDialog");
  assert.equal(dialog.props.open, true);
  assert.match(dialog.props.description, /IMEI de todo el lote son temporales/);
  dialog.props.onConfirm(); await h.flush();
  assert.equal(requests[2].commit, true);
  assert.equal(requests[2].temporaryImeiConfirmed, true);
  assert.equal(requests[2].sadminConfirmed, true);
  assert.match(h.text(), /IMEI temporales pendientes de corrección administrativa/);
});
