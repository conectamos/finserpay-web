import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "session";
const SELLER_SESSION_COOKIE_NAME = "seller_session";

const LEGACY_PAGE_PREFIXES = [
  "/inventario",
  "/inventario-principal",
  "/ventas",
  "/caja",
  "/prestamos",
  "/alertas/prestamos",
  "/dashboard/financiero",
  "/dashboard/deuda-sedes",
];

const ADMIN_ONLY_DASHBOARD_PREFIXES = [
  "/dashboard/catalogo-equipos",
  "/dashboard/equality",
  "/dashboard/integraciones",
  "/dashboard/parametros-credito",
  "/dashboard/sedes",
  "/dashboard/usuarios",
];

const PUBLIC_API_PREFIXES = [
  "/api/clientes",
  "/api/health",
  "/api/login",
  "/api/logout",
  "/api/wompi",
  "/api/creditos/captura-session/",
];

const PROTECTED_API_PREFIXES = [
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

function redirectToDashboard(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/dashboard";
  url.search = "";

  return NextResponse.redirect(url);
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";

  return NextResponse.redirect(url);
}

function unauthorizedApi() {
  return NextResponse.json({ error: "No autenticado" }, { status: 401 });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const hasSellerProfile = Boolean(
    request.cookies.get(SELLER_SESSION_COOKIE_NAME)?.value
  );

  if (pathname.startsWith("/api/")) {
    if (pathMatches(pathname, PUBLIC_API_PREFIXES)) {
      return NextResponse.next();
    }

    if (pathMatches(pathname, PROTECTED_API_PREFIXES) && !hasSession) {
      return unauthorizedApi();
    }

    if (hasSellerProfile && pathMatches(pathname, ADMIN_ONLY_API_PREFIXES)) {
      return NextResponse.json({ error: "Acceso no autorizado" }, { status: 403 });
    }

    return NextResponse.next();
  }

  if (pathMatches(pathname, LEGACY_PAGE_PREFIXES)) {
    return hasSession ? redirectToDashboard(request) : redirectToLogin(request);
  }

  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    if (!hasSession) {
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
