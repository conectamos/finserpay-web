import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { loadPublicMerchants, loadPublicMerchantImage, validatePublicMerchant, canManagePublicMerchants, prepareMerchantImage, saveManagedMerchant } = await jiti.import("../lib/public-merchants.ts");
const valid = { nombre: "Comercio de prueba", direccion: "Calle 1 # 2-3, Ibagué", telefono: "312 408 5562", publicado: true };

test("solo el administrador central puede gestionar el directorio público", () => {
  assert.equal(canManagePublicMerchants(null), false);
  assert.equal(canManagePublicMerchants({ rolNombre: "ADMIN", aliadoAccesoCodigo: "CONECTAMOS" }), false);
  assert.equal(canManagePublicMerchants({ rolNombre: "VENDEDOR", aliadoAccesoCodigo: "FINSERPAY" }), false);
  assert.equal(canManagePublicMerchants({ rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }), true);
});
test("valida los cuatro datos públicos y normaliza el celular colombiano", () => {
  assert.equal(validatePublicMerchant(valid).telefono, "573124085562");
  for (const overrides of [{ nombre: "" }, { direccion: "" }, { telefono: "javascript:alert(1)" }, { publicado: "true" }]) assert.throws(() => validatePublicMerchant({ ...valid, ...overrides }));
});
test("un directorio aún no configurado queda vacío sin consultar aliados operativos", async () => {
  let calls = 0;
  assert.deepEqual(await loadPublicMerchants({ $queryRaw: async () => { calls++; return [{ name: null }]; } }), []);
  assert.equal(calls, 1);
});
test("la consulta pública excluye borradores e imagen inline; no selecciona información operativa", async () => {
  let query = "";
  const expected = [{ id: "123", ...valid }];
  const result = await loadPublicMerchants({ $queryRaw: async (parts) => {
    const sql = parts.join("?");
    if (sql.includes("to_regclass")) return [{ name: '"PublicMerchant"' }];
    query = sql; return expected;
  } });
  assert.equal(result, expected);
  assert.match(query, /WHERE "publicado" = true/);
  assert.match(query, /SELECT "id", "nombre", "direccion", "telefono"/);
  assert.doesNotMatch(query, /Aliado|Credito|imagen/);
});
test("la imagen de un comercio oculto no se entrega y el id se parametriza", async () => {
  let bound;
  assert.equal(await loadPublicMerchantImage({ $queryRaw: async (parts, ...values) => {
    if (parts.join("").includes("to_regclass")) return [{ name: '"PublicMerchant"' }];
    assert.match(parts.join("?"), /"publicado" = true/); bound = values[0]; return [];
  } }, "00000000-0000-4000-8000-000000000001"), null);
  assert.equal(bound, "00000000-0000-4000-8000-000000000001");
});
test("normaliza fotos a WebP y rechaza SVG, datos inválidos y archivos grandes", async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const result = await prepareMerchantImage(`data:image/png;base64,${png.toString("base64")}`);
  assert.match(result, /^data:image\/webp;base64,/);
  for (const input of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,AAAA", "x".repeat(3_000_001)]) await assert.rejects(prepareMerchantImage(input));
});
test("crear sin imagen o con datos inválidos no modifica la base de datos", async () => {
  const client = { $executeRawUnsafe: () => { throw new Error("must not write"); } };
  await assert.rejects(saveManagedMerchant(client, valid, false), /imagen/);
  await assert.rejects(saveManagedMerchant(client, { ...valid, nombre: "" }, false), /nombre/);
});

test("PostgreSQL: crear, editar conservando la foto, ocultar y volver a publicar", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const client = {
    $executeRawUnsafe: async (sql) => { await db.exec(sql); return 0; },
    $queryRaw: async (parts, ...values) => {
      const sql = parts.reduce((query, part, index) => query + (index ? `$${index}` : "") + part, "");
      return (await db.query(sql, values)).rows;
    },
  };
  try {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const [{ id }] = await saveManagedMerchant(client, { ...valid, imagen: `data:image/png;base64,${image.toString("base64")}` }, false);
    const publicRows = await loadPublicMerchants(client);
    assert.deepEqual(publicRows, [{ id, nombre: valid.nombre, direccion: valid.direccion, telefono: "573124085562" }]);
    const originalImage = await loadPublicMerchantImage(client, id);
    await saveManagedMerchant(client, { ...valid, id, nombre: "Nuevo nombre", imagen: "" }, true);
    assert.equal((await loadPublicMerchants(client))[0].nombre, "Nuevo nombre");
    assert.equal(await loadPublicMerchantImage(client, id), originalImage);
    await saveManagedMerchant(client, { id, publicado: false }, true);
    assert.deepEqual(await loadPublicMerchants(client), []);
    assert.equal(await loadPublicMerchantImage(client, id), null);
    await saveManagedMerchant(client, { id, publicado: true }, true);
    assert.equal((await loadPublicMerchants(client)).length, 1);
    assert.deepEqual(await saveManagedMerchant(client, { id: "00000000-0000-4000-8000-000000000099", publicado: false }, true), []);
  } finally { await db.close(); }
});
