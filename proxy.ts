import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/dashboard";
  url.search = "";

  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/inventario/:path*",
    "/inventario-principal/:path*",
    "/ventas/:path*",
    "/caja/:path*",
    "/prestamos/:path*",
    "/alertas/prestamos/:path*",
    "/dashboard/financiero/:path*",
    "/dashboard/deuda-sedes/:path*",
    "/dashboard/sedes/:path*",
  ],
};
