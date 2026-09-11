import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const assetPath = fileURLToPath(new URL(
  "../public/assets/creditos/datacredito-daily-quota-sad-mascot.png",
  import.meta.url
));
const image = sharp(assetPath);
const metadata = await image.metadata();
const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
const rgbaAt = (x, y) => {
  const offset = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(offset, offset + info.channels));
};

test("la mascota aprobada conserva sus dimensiones y un canal alfa real", () => {
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1145);
  assert.equal(metadata.height, 1374);
  assert.equal(metadata.channels, 4);
  assert.equal(metadata.hasAlpha, true);
  assert.equal(info.channels, 4);
});

test("el exterior y los huecos entre las extremidades son transparentes", () => {
  for (const [label, x, y] of [
    ["esquina superior izquierda", 0, 0],
    ["esquina superior derecha", 1144, 0],
    ["esquina inferior izquierda", 0, 1373],
    ["esquina inferior derecha", 1144, 1373],
    ["hueco entre brazo y celular", 805, 600],
    ["hueco entre las piernas", 500, 1020],
  ]) {
    assert.equal(rgbaAt(x, y)[3], 0, label);
  }
});

test("la cara y la moneda conservan pixeles opacos del personaje aprobado", () => {
  // These approved-image anchors catch accidental repainting or removal without
  // depending on the user's original image outside the repository.
  assert.deepEqual(rgbaAt(520, 540), [41, 40, 41, 255], "El centro oscuro de la cara se conserva");
  const coin = rgbaAt(900, 480);
  assert.deepEqual(coin, [254, 204, 60, 255], "La moneda conserva su amarillo y opacidad");
  assert.ok(coin[0] > 200 && coin[1] > 150 && coin[2] < 100, "La moneda sigue amarilla");
});

test("el fondo removido supera la mitad de la imagen y mantiene bordes suavizados", () => {
  let transparent = 0;
  let partial = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    const alpha = data[index];
    if (alpha === 0) transparent += 1;
    else if (alpha < 255) partial += 1;
  }
  assert.ok(transparent / (info.width * info.height) > 0.5,
    "El PNG no debe volver a incluir un fondo blanco o cuadriculado opaco");
  assert.ok(partial > 0, "El recorte conserva transiciones alfa en el contorno");
});
