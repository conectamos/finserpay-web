const MAX_EVIDENCE_DATA_URL_LENGTH = 2_450_000;

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("La imagen seleccionada no es valida"));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

export async function normalizeEvidenceFile(file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Selecciona una imagen PNG o JPEG");
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  if (
    originalDataUrl.length <= MAX_EVIDENCE_DATA_URL_LENGTH &&
    /^data:image\/(?:png|jpe?g);base64,/i.test(originalDataUrl)
  ) {
    return originalDataUrl;
  }

  const image = await loadImage(originalDataUrl);
  const maxSide = 2_200;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Este navegador no pudo preparar la imagen");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.88, 0.78, 0.68, 0.58]) {
    const compressed = canvas.toDataURL("image/jpeg", quality);
    if (compressed.length <= MAX_EVIDENCE_DATA_URL_LENGTH) return compressed;
  }

  throw new Error("La imagen es demasiado pesada; selecciona una de menor tamano");
}
