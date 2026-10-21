import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { readDeliveryBody, DeliveryBodyTooLargeError } = loadReissueModule("lib/ally-settlement-delivery-body.ts");

function streamedRequest(chunks, headers = {}) {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index === chunks.length) return controller.close();
      controller.enqueue(new Uint8Array(chunks[index++]));
    },
    cancel() { cancelled = true; },
  });
  return {
    request: new Request("https://qa.invalid/webhook", { method: "POST", headers, body: stream, duplex: "half" }),
    stream,
    cancelled: () => cancelled,
  };
}

test("rechaza Content-Length excesivo antes de adquirir un lector o consumir el cuerpo", async () => {
  const request = {
    headers: new Headers({ "Content-Length": "2049" }),
    body: { getReader: () => assert.fail("An oversized declared body must not be read") },
  };
  await assert.rejects(readDeliveryBody(request, 2048), DeliveryBodyTooLargeError);
});

test("cuerpo fragmentado sin Content-Length tiene límite en bytes UTF-8, no caracteres", async () => {
  const bytes = Buffer.from("é".repeat(1025), "utf8");
  assert.equal(bytes.byteLength, 2050);
  const f = streamedRequest([bytes.subarray(0, 1023), bytes.subarray(1023), Buffer.from("unread")]);
  assert.equal(f.request.headers.get("content-length"), null);
  await assert.rejects(readDeliveryBody(f.request, 2048), DeliveryBodyTooLargeError);
  assert.equal(f.cancelled(), true, "Overflow must cancel the source before reading additional chunks");
  assert.equal(f.stream.locked, false, "The reader lock is always released after overflow");
});

test("un Content-Length menor que el real no elude el límite durante streaming", async () => {
  const f = streamedRequest([Buffer.from("1234"), Buffer.from("5678"), Buffer.from("extra")], { "Content-Length": "4" });
  await assert.rejects(readDeliveryBody(f.request, 7), DeliveryBodyTooLargeError);
  assert.equal(f.cancelled(), true);
  assert.equal(f.stream.locked, false);
});

test("acepta exactamente el máximo de bytes aunque un carácter UTF-8 cruce fragmentos", async () => {
  const text = "á".repeat(1024);
  const bytes = Buffer.from(text, "utf8");
  assert.equal(bytes.byteLength, 2048);
  const f = streamedRequest([bytes.subarray(0, 1), bytes.subarray(1, 1001), bytes.subarray(1001, 2047), bytes.subarray(2047)]);
  const actual = await readDeliveryBody(f.request, 2048);
  assert.equal(actual, text);
  assert.deepEqual(Buffer.from(actual, "utf8"), bytes);
  assert.equal(f.cancelled(), false);
  assert.equal(f.stream.locked, false);
});

test("conserva bytes y espacios originales del JSON para verificar la firma del webhook", async () => {
  const raw = '\r\n { "nombre": "Aliado Perú 🌎", "valor": 1.00, "escape": "\\u00e1" } \n';
  const bytes = Buffer.from(raw, "utf8");
  const f = streamedRequest(Array.from(bytes, byte => Uint8Array.of(byte)), { "Content-Length": String(bytes.byteLength) });
  const actual = await readDeliveryBody(f.request, bytes.byteLength);
  assert.equal(actual, raw);
  assert.deepEqual(Buffer.from(actual, "utf8"), bytes);
});

test("sin cuerpo o con stream vacío devuelve texto vacío", async () => {
  assert.equal(await readDeliveryBody(new Request("https://qa.invalid/status"), 2048), "");
  const f = streamedRequest([]);
  assert.equal(await readDeliveryBody(f.request, 2048), "");
  assert.equal(f.stream.locked, false);
});

test("un error de lectura se propaga y libera el lector", async () => {
  const expected = new Error("stream interrupted");
  const stream = new ReadableStream({ pull(controller) { controller.error(expected); } });
  const request = new Request("https://qa.invalid/webhook", { method: "POST", body: stream, duplex: "half" });
  await assert.rejects(readDeliveryBody(request, 2048), error => error === expected);
  assert.equal(stream.locked, false);
});
