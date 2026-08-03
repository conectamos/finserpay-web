export type ClientPdfDownload = {
  blob: Blob;
  filename: string;
};

type FetchClientPdf = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

function safePdfFilename(value: string, fallback: string) {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .trim();
  const filename = sanitized || fallback;

  return filename.toLowerCase().endsWith(".pdf")
    ? filename
    : `${filename}.pdf`;
}

export function clientPdfFilename(
  contentDisposition: string | null,
  fallback: string
) {
  const fallbackFilename = safePdfFilename(fallback, "documento-finser-pay.pdf");

  if (!contentDisposition) {
    return fallbackFilename;
  }

  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];

  if (encoded) {
    try {
      return safePdfFilename(decodeURIComponent(encoded.trim()), fallbackFilename);
    } catch {
      // Continue with the regular filename or the fallback.
    }
  }

  const regular = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  return regular
    ? safePdfFilename(regular.trim(), fallbackFilename)
    : fallbackFilename;
}

async function responseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    const message = String(payload.error || "").trim();

    if (message) {
      return message;
    }
  } catch {
    // The endpoint may return a non-JSON proxy error.
  }

  return `No se pudo preparar el documento (${response.status}).`;
}

export async function fetchClientPdf(
  href: string,
  fallbackFilename: string,
  fetcher: FetchClientPdf = fetch
): Promise<ClientPdfDownload> {
  const response = await fetcher(href, {
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(await responseError(response));
  }

  const contentType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/pdf") {
    throw new Error("El servidor no entrego un archivo PDF valido.");
  }

  const blob = await response.blob();

  if (!blob.size) {
    throw new Error("El paz y salvo se genero vacio. Intenta de nuevo.");
  }

  const signature = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  const isPdf =
    signature.length === 5 &&
    signature[0] === 0x25 &&
    signature[1] === 0x50 &&
    signature[2] === 0x44 &&
    signature[3] === 0x46 &&
    signature[4] === 0x2d;

  if (!isPdf) {
    throw new Error("El servidor entrego un archivo PDF invalido.");
  }

  return {
    blob,
    filename: clientPdfFilename(
      response.headers.get("content-disposition"),
      fallbackFilename
    ),
  };
}
