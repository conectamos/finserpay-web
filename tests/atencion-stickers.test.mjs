import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import sharp from "sharp";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { readAttentionStickerSource, saveAttentionMessageSticker } = await jiti.import("../lib/atencion-sticker-source.ts");
const { readStickerUpload } = await jiti.import("../lib/atencion-sticker-library.ts");
const { AttentionError } = await jiti.import("../lib/atencion-core.ts");
const actor = { userId: 1, key: "admin:1" };
const input = () => ({ requestId: randomUUID(), name: "Gracias", conversationId: randomUUID(), messageId: randomUUID() });

test("guardar un sticker recibido solo acepta IDs internos y nombre, sin URL ni contenido aportado por el cliente", () => {
  const valid = input(); assert.deepEqual(readAttentionStickerSource(valid), valid);
  for (const extra of [{ url: "https://example.invalid/token" }, { mediaId: "123" }, { content: "fake" }, { mimeType: "image/webp" }, { kind: "sticker" }]) {
    assert.throws(() => readAttentionStickerSource({ ...valid, ...extra }), { status: 400 });
  }
  for (const change of [{ messageId: "arbitrary-provider-id" }, { conversationId: "other" }, { name: "" }, { requestId: "bad" }]) {
    assert.throws(() => readAttentionStickerSource({ ...valid, ...change }), { status: 400 });
  }
});

test("la fuente autorizada es el único origen del sticker y no hay envío a Meta", async () => {
  const source = input(), bytes = await sharp({ create: { width: 512, height: 512, channels: 4, background: "green" } }).webp().toBuffer();
  let reads = 0, writes = 0;
  const saved = { id: randomUUID(), name: source.name };
  const result = await saveAttentionMessageSticker(actor, source, {
    async media(who, conversationId, messageId) { reads++; assert.equal(who, actor); assert.equal(conversationId, source.conversationId); assert.equal(messageId, source.messageId); return { bytes, kind: "sticker", mimeType: "image/webp", status: 200 }; },
    async save(who, value) { writes++; assert.equal(who, actor); assert.deepEqual(value, { requestId: source.requestId, name: source.name, content: bytes }); return saved; },
  });
  assert.equal(result, saved); assert.equal(reads, 1); assert.equal(writes, 1);
});

test("un mensaje ajeno, reasignado durante la lectura o un archivo distinto nunca se guarda como sticker", async () => {
  let writes = 0;
  const save = async () => { writes++; throw new Error("must not save"); };
  for (const status of [401, 403, 404]) await assert.rejects(saveAttentionMessageSticker(actor, input(), {
    media: async () => { throw new AttentionError("Acceso revocado", status); }, save,
  }), { status });
  for (const media of [
    { kind: "image", mimeType: "image/webp", status: 200 },
    { kind: "sticker", mimeType: "image/png", status: 200 },
    { kind: "sticker", mimeType: "image/webp", status: 206 },
  ]) await assert.rejects(saveAttentionMessageSticker(actor, input(), { media: async () => ({ ...media, bytes: new Uint8Array([1]) }), save }), { status: 409 });
  assert.equal(writes, 0);
});

test("una foto compleja se convierte sin recortar a un sticker estático dentro de 100 KB", async () => {
  const pixels = Buffer.alloc(900 * 600 * 3); let seed = 123456789;
  for (let index = 0; index < pixels.length; index++) { seed = (1664525 * seed + 1013904223) >>> 0; pixels[index] = seed >>> 24; }
  const png = await sharp(pixels, { raw: { width: 900, height: 600, channels: 3 } }).png().toBuffer();
  const form = new FormData(); form.set("requestId", randomUUID()); form.set("name", "Foto"); form.set("file", new Blob([png], { type: "image/png" }), "foto.png");
  const prepared = await readStickerUpload(new Request("https://example.invalid", { method: "POST", body: form }));
  const meta = await sharp(prepared.content).metadata();
  assert.equal(meta.format, "webp"); assert.equal(meta.width, 512); assert.equal(meta.height, 512); assert.ok(prepared.content.length <= 100 * 1024);
  assert.equal(meta.hasAlpha, true, "se conserva el espacio transparente, sin recortar la foto");
});

test("ruta para guardar un sticker exige origen y sesión, responde privada y no expone datos del proveedor", async () => {
  const { outputText } = ts.transpileModule(readFileSync(path.join(root, "app/api/atencion/stickers/from-message/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const http = await jiti.import("../lib/atencion-http.ts");
  const calls = []; let authenticated = true, sourceKind = "sticker";
  const module = { exports: {} };
  runInNewContext(outputText, { module, exports: module.exports, Promise, require(name) {
    if (name === "@/lib/atencion-core") return { AttentionError, getAttentionAccess: async () => { calls.push("access"); if (!authenticated) throw new AttentionError("Sin sesión", 401); return actor; } };
    if (name === "@/lib/atencion-http") return http;
    if (name === "@/lib/atencion-meta-service") return { attentionMetaRuntime: async () => ({
      store: { getMedia: async () => { calls.push("descriptor"); return { kind: sourceKind, mimeType: "image/webp" }; } },
      service: { media: async () => { calls.push("download"); return { bytes: new Uint8Array([1]), kind: "sticker", mimeType: "image/webp", status: 200 }; } },
    }) };
    if (name === "@/lib/atencion-sticker-library") return { attentionStickerLibrary: async () => ({ save: async (who, data) => { calls.push("save"); assert.equal(who, actor); return { id: randomUUID(), name: data.name }; } }) };
    if (name === "@/lib/atencion-sticker-source") return { saveAttentionMessageSticker };
    throw new Error(`Unexpected import ${name}`);
  } });
  const request = (origin = "https://finser.test") => new Request("https://finser.test/api/atencion/stickers/from-message", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(input()) });
  let response = await module.exports.POST(request("https://evil.invalid")); assert.equal(response.status, 403); assert.deepEqual(calls, []);
  authenticated = false; response = await module.exports.POST(request()); assert.equal(response.status, 401); assert.deepEqual(calls, ["access"]);
  authenticated = true; response = await module.exports.POST(request()); assert.equal(response.status, 200); assert.match(response.headers.get("Cache-Control"), /private, no-store/); assert.equal(response.headers.get("Vary"), "Cookie"); assert.equal(calls.filter(value => value === "save").length, 1);
  assert.deepEqual(calls.slice(-3), ["descriptor", "download", "save"]);
  sourceKind = "document"; response = await module.exports.POST(request()); assert.equal(response.status, 409);
  assert.equal(calls.filter(value => value === "download").length, 1, "el documento se rechaza antes de descargar sus bytes");
  assert.equal(calls.filter(value => value === "save").length, 1);
});

test("la vista previa de creación revoca sus bytes locales y nunca prepara contenido no admitido", () => {
  const source = readFileSync(path.join(root, "app/dashboard/atencion/attention-sticker-picker.tsx"), "utf8") + "\nexport const stickerTest = { StickerUploadPreview, stickerUploadError };";
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const cleanups = [], created = [], revoked = [], image = { src: "", removeAttribute(key) { if (key === "src") this.src = ""; } };
  const module = { exports: {} };
  runInNewContext(outputText, { module, exports: module.exports, URL: { createObjectURL(file) { created.push(file); return "blob:private-preview"; }, revokeObjectURL(url) { revoked.push(url); } }, require(name) {
    if (name === "react") return { useRef: () => ({ current: image }), useEffect: effect => cleanups.push(effect()), useState: () => [] };
    if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
    return { default: () => null };
  } });
  const ui = module.exports.stickerTest, valid = new File(["local bytes"], "gracias.png", { type: "image/png" });
  assert.equal(ui.stickerUploadError(valid), null); ui.StickerUploadPreview({ file: valid });
  assert.equal(image.src, "blob:private-preview"); assert.equal(created.length, 1); cleanups.at(-1)();
  assert.equal(image.src, ""); assert.deepEqual(revoked, ["blob:private-preview"]);
  const unsafe = new File(["<svg/>"] , "otro.svg", { type: "image/svg+xml" });
  assert.match(ui.stickerUploadError(unsafe), /JPG/); assert.equal(ui.StickerUploadPreview({ file: unsafe }), null); assert.equal(created.length, 1);
  const tooLarge = new File([new Uint8Array(500 * 1024 + 1)], "grande.webp", { type: "image/webp" });
  assert.match(ui.stickerUploadError(tooLarge), /500 KB/);
});
