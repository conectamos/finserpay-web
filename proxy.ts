import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "session";
const APPROVAL_ANALYST_SESSION_COOKIE_NAME = "approval_analyst_session";
const APPROVAL_ACCESS_COOKIE_NAME = "approval_access_session";
const APPROVAL_SHARED_COOKIE_NAME = "approval_shared_session";
const SELLER_SESSION_COOKIE_NAME = "seller_session";
const APPROVAL_ANALYST_RETRY_RELEASE_ROUTE =
  /^\/api\/creditos\/datacredito\/admin\/evaluaciones\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/autorizar-reintento$/i;
const APPROVAL_ANALYST_WELCOME_VOICE_ROUTE =
  /^\/api\/creditos\/[1-9]\d*\/bienvenida-voz$/;

const LEGACY_PAGE_PREFIXES = [
  "/inventario",
  "/inventario-principal",
  "/ventas",
  "/caja",
  "/prestamos",
  "/alertas/prestamos",
  "/dashboard/deuda-sedes",
];

const ADMIN_ONLY_DASHBOARD_PREFIXES = [
  "/dashboard/atencion",
  "/dashboard/comisiones",
  "/dashboard/cartera",
  "/dashboard/riesgo-referencia",
  "/dashboard/catalogo-equipos",
  "/dashboard/equality",
  "/dashboard/integraciones",
  "/dashboard/parametros-credito",
  "/dashboard/sedes",
  "/dashboard/usuarios",
];

const PUBLIC_API_PREFIXES = [
  "/api/clientes",
  "/api/public/comercios",
  "/api/creditos/push-reminders",
  "/api/creditos/sync-mora",
  "/api/health",
  "/api/login",
  "/api/logout",
  "/api/public/iphone-enrollment",
  "/api/public/approval-access",
  "/api/public/approval-shared-access",
  "/api/wompi",
  "/api/creditos/captura-session/",
];

const BEARER_AUTH_API_ROUTES = new Set([
  "/api/creditos/datacredito/retencion",
]);

const PROTECTED_API_PREFIXES = [
  "/api/atencion",
  "/api/comisiones",
  "/api/admin/comisiones",
  "/api/aprobaciones",
  "/api/alertas",
  "/api/arqueo",
  "/api/caja",
  "/api/creditos",
  "/api/dashboard",
  "/api/equality",
  "/api/financiero",
  "/api/inventario",
  "/api/inventario-principal",
  "/api/prestamos",
  "/api/reportes",
  "/api/sedes",
  "/api/session",
  "/api/usuarios",
  "/api/vendedores",
  "/api/ventas",
];

const ADMIN_ONLY_API_PREFIXES = [
  "/api/atencion",
  "/api/admin/comisiones",
  "/api/alertas",
  "/api/arqueo",
  "/api/caja",
  "/api/dashboard/deuda-sedes",
  "/api/dashboard/financiero",
  "/api/financiero",
  "/api/inventario",
  "/api/inventario-principal",
  "/api/prestamos",
  "/api/sedes/admin",
  "/api/usuarios/admin",
  "/api/ventas",
];

function pathMatches(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (prefix) =>
      prefix.endsWith("/")
        ? pathname.startsWith(prefix)
        : pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

// The commercial inbox has its own nominal seller/ownership checks in every
// handler. Keep this exception limited to its supported routes and methods;
// the rest of /api/ventas remains administrative.
function isSellerAttentionApi(pathname: string, method: string) {
  if (pathname === "/api/ventas/atencion") return method === "GET" || method === "POST";
  if (pathname === "/api/ventas/atencion/events") return method === "GET";
  if (pathname === "/api/ventas/atencion/notificaciones") return method === "GET" || method === "PATCH";
  if (pathname === "/api/ventas/atencion/notificaciones/push") return method === "GET" || method === "POST" || method === "DELETE";
  const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (new RegExp(`^/api/ventas/atencion/${id}$`, "i").test(pathname)) return method === "GET" || method === "PATCH";
  if (new RegExp(`^/api/ventas/atencion/${id}/files$`, "i").test(pathname)) return method === "POST";
  return method === "GET" && new RegExp(`^/api/ventas/atencion/${id}/files/${id}$`, "i").test(pathname);
}

function redirectToDashboard(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/dashboard";
  url.search = "";

  return NextResponse.redirect(url);
}

function redirectToAnalystCenter(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/dashboard/aprobaciones/centro";
  url.search = request.nextUrl.pathname === "/dashboard" && /(?:^\?|&)notifications=1(?:&|$)/.test(request.nextUrl.search)
    ? "?notifications=1" : "";

  return NextResponse.redirect(url);
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/aliados";
  url.search = "";

  return NextResponse.redirect(url);
}

function unauthorizedApi() {
  return NextResponse.json({ error: "No autenticado" }, { status: 401 });
}

function usesDedicatedBearerAuth(request: NextRequest, pathname: string) {
  return (
    request.method === "POST" &&
    BEARER_AUTH_API_ROUTES.has(pathname) &&
    /^Bearer\s+.+$/i.test(request.headers.get("authorization") || "")
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // These public assets contain no session data and must update after logout.
  if ((request.method === "GET" || request.method === "HEAD") &&
      (pathname === "/dashboard/notifications-sw.js" || pathname === "/dashboard/manifest.webmanifest")) {
    return NextResponse.next();
  }
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const hasApprovalAnalystSession = Boolean(
    request.cookies.get(APPROVAL_ANALYST_SESSION_COOKIE_NAME)?.value
  );
  const hasApprovalAccess = Boolean(request.cookies.get(APPROVAL_ACCESS_COOKIE_NAME)?.value);
  const hasSharedApprovalAccess = Boolean(request.cookies.get(APPROVAL_SHARED_COOKIE_NAME)?.value);
  const approvalApi = pathMatches(pathname, ["/api/aprobaciones"]);
  const approvalPage = pathMatches(pathname, ["/dashboard/aprobaciones"]);
  // Attention keeps its own server-side nominal/central authorization. It is
  // not an approval route: approval links must not inherit access to the CRM.
  const attentionApi = pathMatches(pathname, ["/api/atencion"]);
  const attentionPage = pathMatches(pathname, ["/dashboard/atencion"]);
  const approvalAnalystRetryReleaseApi =
    request.method === "POST" && (
      pathname === "/api/creditos/datacredito/admin/liberaciones/buscar" ||
      APPROVAL_ANALYST_RETRY_RELEASE_ROUTE.test(pathname)
    );
  const approvalAnalystSolicitudesApi =
    ["GET", "PATCH"].includes(request.method) && pathname === "/api/solicitudes";
  const approvalAnalystWelcomeVoiceApi =
    ["GET", "POST"].includes(request.method) && APPROVAL_ANALYST_WELCOME_VOICE_ROUTE.test(pathname);
  const approvalAnalystApi =
    approvalApi ||
    attentionApi ||
    approvalAnalystRetryReleaseApi ||
    approvalAnalystSolicitudesApi ||
    approvalAnalystWelcomeVoiceApi ||
    pathname === "/api/session" ||
    pathname === "/api/login" ||
    pathname === "/api/logout";
  const hasSellerProfile = Boolean(
    request.cookies.get(SELLER_SESSION_COOKIE_NAME)?.value
  );

  if (pathname.startsWith("/api/")) {
    // El portal del cliente es público y no hereda el alcance de una sesión
    // de Aprobaciones que el navegador pueda conservar, incluso si venció.
    const clientPortalApi = pathMatches(pathname, ["/api/clientes"]);
    const publicMerchantApi = request.method === "GET" && pathMatches(pathname, ["/api/public/comercios"]);
    if (hasApprovalAnalystSession && !approvalAnalystApi && !clientPortalApi && !publicMerchantApi) {
      return NextResponse.json({ error: "Acceso no autorizado" }, { status: 403 });
    }

    if (usesDedicatedBearerAuth(request, pathname)) {
      return NextResponse.next();
    }

    if (pathMatches(pathname, PUBLIC_API_PREFIXES)) {
      return NextResponse.next();
    }

    if (
      pathMatches(pathname, PROTECTED_API_PREFIXES) &&
      !hasSession &&
      !(approvalAnalystApi && hasApprovalAnalystSession) &&
      !(approvalApi && (hasApprovalAccess || hasSharedApprovalAccess))
    ) {
      return unauthorizedApi();
    }

    if (hasSellerProfile && pathMatches(pathname, ADMIN_ONLY_API_PREFIXES) && !isSellerAttentionApi(pathname, request.method)) {
      return NextResponse.json({ error: "Acceso no autorizado" }, { status: 403 });
    }

    return NextResponse.next();
  }

  if (hasApprovalAnalystSession && pathname !== "/aliados" && !approvalPage && !attentionPage) {
    return redirectToAnalystCenter(request);
  }

  if (pathMatches(pathname, LEGACY_PAGE_PREFIXES)) {
    return hasSession ? redirectToDashboard(request) : redirectToLogin(request);
  }

  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    if (
      !hasSession &&
      !(approvalPage && hasApprovalAnalystSession) &&
      !(attentionPage && hasApprovalAnalystSession) &&
      !(approvalPage && hasApprovalAccess)
    ) {
      return redirectToLogin(request);
    }

    if (
      hasSellerProfile &&
      pathMatches(pathname, ADMIN_ONLY_DASHBOARD_PREFIXES)
    ) {
      return redirectToDashboard(request);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/:path*",
    "/dashboard",
    "/dashboard/:path*",
    "/inventario/:path*",
    "/inventario-principal/:path*",
    "/ventas/:path*",
    "/caja/:path*",
    "/prestamos/:path*",
    "/alertas/prestamos/:path*",
    "/dashboard/financiero/:path*",
    "/dashboard/deuda-sedes/:path*",
  ],
};
