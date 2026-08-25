export const VERIFF_COMPLETION_PATH = "/validacion-identidad/completada";

function normalizePublicBaseUrl(value: string | null | undefined) {
  const cleaned = String(value || "").trim().replace(/\/+$/, "");

  if (!cleaned) {
    return "";
  }

  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

export function buildVeriffCompletionUrl(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env
) {
  const configuredOrigin =
    normalizePublicBaseUrl(environment.NEXT_PUBLIC_APP_URL) ||
    normalizePublicBaseUrl(environment.APP_URL) ||
    normalizePublicBaseUrl(environment.RAILWAY_PUBLIC_DOMAIN);

  if (configuredOrigin) {
    return new URL(VERIFF_COMPLETION_PATH, `${configuredOrigin}/`).toString();
  }

  const requestUrl = new URL(request.url);
  const forwardedHost = firstForwardedValue(
    request.headers.get("x-forwarded-host")
  );
  const forwardedProtocol = firstForwardedValue(
    request.headers.get("x-forwarded-proto")
  );
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const protocol = forwardedProtocol || requestUrl.protocol.replace(":", "");

  return `${protocol}://${host}${VERIFF_COMPLETION_PATH}`;
}
