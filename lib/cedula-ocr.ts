"use client";

export type CedulaValidationCheck = {
  key: "documento" | "primerNombre" | "primerApellido" | "fechaNacimiento" | "fechaExpedicion";
  label: string;
  expected: string;
  matched: boolean;
  detected: string | null;
};

export type CedulaValidationResult = {
  status: "valid" | "invalid";
  summary: string;
  checkedAt: string;
  checks: CedulaValidationCheck[];
  frontText: string;
  backText: string;
};

type CedulaValidationInput = {
  frontImage: string;
  backImage: string;
  firstName: string;
  lastName: string;
  documentNumber: string;
  birthDate: string;
  issueDate: string;
};

type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ContrastProfile = "soft" | "strong";

type OcrVariantDefinition = {
  crop?: ImageCrop;
  maxSide?: number;
  contrast?: ContrastProfile;
};

function stripAccents(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(value: string) {
  return stripAccents(String(value || ""))
    .toUpperCase()
    .replace(/[^A-Z0-9/\-.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function onlyDigits(value: string) {
  return String(value || "").replace(/\D/g, "");
}

function formatDateLabel(isoDate: string) {
  if (!isoDate) {
    return "";
  }

  const date = new Date(`${isoDate}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }

  return date.toLocaleDateString("es-CO");
}

function buildDateVariants(isoDate: string) {
  if (!isoDate) {
    return [];
  }

  const [year, month, day] = isoDate.split("-");

  if (!year || !month || !day) {
    return [];
  }

  return [
    `${day}/${month}/${year}`,
    `${day}-${month}-${year}`,
    `${day}.${month}.${year}`,
    `${day} ${month} ${year}`,
    `${day}${month}${year}`,
    `${year}-${month}-${day}`,
    `${year}/${month}/${day}`,
  ];
}

function matchDateInText(text: string, isoDate: string) {
  const variants = buildDateVariants(isoDate);

  if (!variants.length) {
    return { matched: false, detected: null };
  }

  const normalizedText = normalizeText(text);
  const compactText = normalizedText.replace(/\s+/g, "");
  const digitsText = onlyDigits(text);

  for (const variant of variants) {
    const normalizedVariant = normalizeText(variant);
    const compactVariant = normalizedVariant.replace(/\s+/g, "");
    const digitsVariant = onlyDigits(variant);

    if (
      normalizedText.includes(normalizedVariant) ||
      compactText.includes(compactVariant) ||
      (digitsVariant && digitsText.includes(digitsVariant))
    ) {
      return {
        matched: true,
        detected: formatDateLabel(isoDate),
      };
    }
  }

  return {
    matched: false,
    detected: null,
  };
}

function matchNameToken(text: string, value: string) {
  const normalizedText = normalizeText(text);
  const normalizedValue = normalizeText(value);

  if (!normalizedValue) {
    return { matched: false, detected: null };
  }

  if (normalizedText.includes(normalizedValue)) {
    return {
      matched: true,
      detected: value.trim(),
    };
  }

  const pieces = normalizedValue.split(" ").filter(Boolean);

  if (pieces.length > 1 && pieces.every((piece) => normalizedText.includes(piece))) {
    return {
      matched: true,
      detected: value.trim(),
    };
  }

  return {
    matched: false,
    detected: null,
  };
}

function matchDocument(text: string, documentNumber: string) {
  const expectedDigits = onlyDigits(documentNumber);
  const digitsText = onlyDigits(text);

  if (!expectedDigits) {
    return { matched: false, detected: null };
  }

  if (digitsText.includes(expectedDigits)) {
    return { matched: true, detected: expectedDigits };
  }

  const groups = String(text || "").match(/\d{6,}/g) || [];
  const detected = groups.find(Boolean) || null;

  return {
    matched: false,
    detected,
  };
}

async function loadImage(dataUrl: string) {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("No se pudo preparar la imagen para OCR."));
    image.src = dataUrl;
  });
}

function buildCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("No se pudo preparar el canvas para OCR.");
  }

  return { canvas, context };
}

function applyContrastEnhancement(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  profile: ContrastProfile = "soft"
) {
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  const lowThreshold = profile === "strong" ? 104 : 92;
  const highThreshold = profile === "strong" ? 162 : 148;
  const multiplier = profile === "strong" ? 1.32 : 1.18;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const grayscale = red * 0.299 + green * 0.587 + blue * 0.114;
    const boosted =
      grayscale > highThreshold
        ? 255
        : grayscale < lowThreshold
          ? 0
          : Math.min(255, grayscale * multiplier);

    data[index] = boosted;
    data[index + 1] = boosted;
    data[index + 2] = boosted;
  }

  context.putImageData(imageData, 0, 0);
}

async function buildOcrVariant(
  dataUrl: string,
  options: OcrVariantDefinition = {}
) {
  const image = await loadImage(dataUrl);
  const { crop, maxSide = 2600, contrast = "soft" } = options;
  const sourceX = crop ? Math.round(image.width * crop.x) : 0;
  const sourceY = crop ? Math.round(image.height * crop.y) : 0;
  const sourceWidth = crop
    ? Math.round(image.width * crop.width)
    : image.width;
  const sourceHeight = crop
    ? Math.round(image.height * crop.height)
    : image.height;

  const scale = Math.min(2.8, maxSide / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const { canvas, context } = buildCanvas(targetWidth, targetHeight);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    targetWidth,
    targetHeight
  );

  applyContrastEnhancement(context, targetWidth, targetHeight, contrast);

  return canvas.toDataURL("image/jpeg", 0.96);
}

function getDocumentVariantDefinitions(kind: "front" | "back") {
  const sharedVariants: OcrVariantDefinition[] = [
    { maxSide: 2800, contrast: "soft" },
    {
      crop: { x: 0.06, y: 0.18, width: 0.88, height: 0.58 },
      maxSide: 2800,
      contrast: "soft",
    },
    {
      crop: { x: 0.1, y: 0.24, width: 0.8, height: 0.48 },
      maxSide: 2600,
      contrast: "strong",
    },
    {
      crop: { x: 0.18, y: 0.28, width: 0.64, height: 0.38 },
      maxSide: 2400,
      contrast: "strong",
    },
  ];

  if (kind === "front") {
    return [
      ...sharedVariants,
      {
        crop: { x: 0.04, y: 0.08, width: 0.64, height: 0.34 },
        maxSide: 2400,
        contrast: "strong" as ContrastProfile,
      },
      {
        crop: { x: 0.04, y: 0.36, width: 0.6, height: 0.2 },
        maxSide: 2200,
        contrast: "strong" as ContrastProfile,
      },
    ] satisfies OcrVariantDefinition[];
  }

  return [
    ...sharedVariants,
    {
      crop: { x: 0.12, y: 0.06, width: 0.76, height: 0.3 },
      maxSide: 2200,
      contrast: "strong" as ContrastProfile,
    },
    {
      crop: { x: 0.1, y: 0.48, width: 0.82, height: 0.22 },
      maxSide: 2200,
      contrast: "strong" as ContrastProfile,
    },
  ] satisfies OcrVariantDefinition[];
}

async function recognizeDocumentText(
  worker: { recognize: (image: string) => Promise<{ data: { text: string } }> },
  image: string,
  kind: "front" | "back"
) {
  const variants = await Promise.all(
    getDocumentVariantDefinitions(kind).map((variant) =>
      buildOcrVariant(image, variant)
    )
  );

  const fragments: string[] = [];

  for (const variant of variants) {
    const recognized = await worker.recognize(variant);
    const text = String(recognized.data.text || "").trim();

    if (text) {
      fragments.push(text);
    }
  }

  return fragments.join("\n");
}

export async function runCedulaValidation({
  frontImage,
  backImage,
  firstName,
  lastName,
  documentNumber,
  birthDate,
  issueDate,
}: CedulaValidationInput): Promise<CedulaValidationResult> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("spa");

  try {
    const frontText = await recognizeDocumentText(worker, frontImage, "front");
    const backText = await recognizeDocumentText(worker, backImage, "back");
    const combinedText = `${frontText}\n${backText}`;

    const documentMatch = matchDocument(combinedText, documentNumber);
    const firstNameMatch = matchNameToken(combinedText, firstName);
    const lastNameMatch = matchNameToken(combinedText, lastName);
    const birthDateMatch = matchDateInText(combinedText, birthDate);
    const issueDateMatch = matchDateInText(combinedText, issueDate);

    const checks: CedulaValidationCheck[] = [
      {
        key: "documento",
        label: "Numero de documento",
        expected: documentNumber,
        matched: documentMatch.matched,
        detected: documentMatch.detected,
      },
      {
        key: "primerNombre",
        label: "Primer nombre",
        expected: firstName,
        matched: firstNameMatch.matched,
        detected: firstNameMatch.detected,
      },
      {
        key: "primerApellido",
        label: "Primer apellido",
        expected: lastName,
        matched: lastNameMatch.matched,
        detected: lastNameMatch.detected,
      },
      {
        key: "fechaNacimiento",
        label: "Fecha de nacimiento",
        expected: formatDateLabel(birthDate),
        matched: birthDateMatch.matched,
        detected: birthDateMatch.detected,
      },
      {
        key: "fechaExpedicion",
        label: "Fecha de expedicion",
        expected: formatDateLabel(issueDate),
        matched: issueDateMatch.matched,
        detected: issueDateMatch.detected,
      },
    ];

    const mismatches = checks.filter((item) => !item.matched);
    const detectedCount = checks.filter((item) => Boolean(item.detected)).length;

    return {
      status: mismatches.length ? "invalid" : "valid",
      summary:
        detectedCount === 0
          ? "La cedula no se ve lo suficientemente cerca o nitida. Vuelve a tomarla usando solo el documento dentro del marco y con buena luz."
          : mismatches.length
            ? "La cedula no coincide con los datos digitados. Corrige la venta antes de continuar."
            : "La cedula coincide con la informacion ingresada en la venta.",
      checkedAt: new Date().toISOString(),
      checks,
      frontText,
      backText,
    };
  } finally {
    await worker.terminate();
  }
}
