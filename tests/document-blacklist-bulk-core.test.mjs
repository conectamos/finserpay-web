import assert from "node:assert/strict";
import test from "node:test";
import { core, loadBlacklistModule } from "./document-blacklist-test-loader.mjs";

const bulk = loadBlacklistModule("lib/document-blacklist-bulk-core.ts", { "@/lib/document-blacklist-core": core });

test("texto masivo reconoce saltos, comas, punto y coma y tabulacion, sin inventar cedulas", () => {
  const result = bulk.parseBlacklistBulkText("\uFEFFCédula\r\n 1.062.402.825 \r\n 001062402825, 700123456;800123456\t900123456\n");
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].documento, "1062402825");
  assert.equal(result.rows[1].duplicateOf, 1);
  assert.equal(result.rows[1].documento, result.rows[0].documento);
  assert.deepEqual(Array.from(result.documentos), ["1062402825", "700123456", "800123456", "900123456"]);
});

test("filas invalidas se conservan con posición y explicación; no se omiten silenciosamente", () => {
  const result = bulk.parseBlacklistBulkText("123456\n1.23E+09\n=123456\ncliente 123456\n12\n0000\n123456 987654\n123456\n1 234 567 890");
  assert.equal(result.rows.filter((row) => row.error).length, 6);
  assert.equal(result.rows[1].position, 2);
  assert.equal(result.rows[1].input, "1.23E+09");
  assert.equal(result.rows[7].duplicateOf, 1);
  assert.equal(result.rows[8].documento, "1234567890");
  assert.equal(result.documentos.length, 2);
});

test("solo permite un encabezado al inicio; numeros, arrays y vacios no son listas", () => {
  for (const input of [undefined, null, 123456, ["123456"]]) assert.throws(() => bulk.parseBlacklistBulkText(input), { code: "BULK_INVALID_TEXT" });
  for (const input of ["", "\n\t, ;", "cedula\n"]) assert.throws(() => bulk.parseBlacklistBulkText(input), { code: "BULK_EMPTY" });
  assert.ok(bulk.parseBlacklistBulkText("123456\ncedula").rows[1].error);
  assert.equal(bulk.parseBlacklistBulkText("cc\n123456").rows[0].position, 1);
});

test("limita entradas incluidas repetidas y tamaño antes de consultar la base", () => {
  const text = Array(500).fill("123456").join("\n");
  assert.equal(bulk.parseBlacklistBulkText(text).rows.length, 500);
  assert.equal(bulk.parseBlacklistBulkText("Cédula\n" + text).rows.length, 500);
  assert.equal(bulk.countBlacklistBulkEntries("Cédula\n" + text), 500);
  assert.equal(bulk.countBlacklistBulkEntries("\n\t"), 0);
  assert.throws(() => bulk.parseBlacklistBulkText(text + "\n123456"), { code: "BULK_TOO_MANY_ENTRIES", status: 413 });
  assert.throws(() => bulk.parseBlacklistBulkText("1".repeat(50001)), { code: "BULK_TEXT_TOO_LARGE", status: 413 });
});

test("exige motivo común válido y solo construye identidad desde texto recibido", () => {
  assert.throws(() => bulk.parseBlacklistBulkInput({ texto: "123456", motivo: "no" }), { code: "INVALID_REASON" });
  assert.throws(() => bulk.parseBlacklistBulkInput(null), { code: "INVALID_REQUEST" });
  const input = bulk.parseBlacklistBulkInput({ texto: "123456", motivo: "  Motivo común de prueba  ", actorUserId: 99, documentos: ["666666"] });
  assert.equal(input.motivo, "Motivo común de prueba");
  assert.deepEqual(Array.from(input.parsed.documentos), ["123456"]);
  assert.equal("actorUserId" in input, false);
});
