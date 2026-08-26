import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { normalizeSolicitudFilters, type SolicitudViewer } from "@/lib/solicitudes";
import {
  desistSolicitud,
  desistSolicitudAsCentralAdmin,
  getSolicitudDetail,
  listSolicitudes,
} from "@/lib/solicitudes-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: unknown, init?: ResponseInit) {
  const result = NextResponse.json(body, init);
  result.headers.set("Cache-Control", "private, no-store, max-age=0");
  return result;
}

async function getViewer() {
  const user = await getSessionUser();
  if (!user) return null;

  if (isAdminRole(user.rolNombre)) {
    const central = isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    return {
      user,
      seller: null,
      viewer: {
        kind: central ? "CENTRAL_ADMIN" : "ALLY_ADMIN",
        userId: user.id,
        aliadoId: user.aliadoAccesoId,
        sedeId: central ? null : user.sedeAccesoId,
        vendedorId: null,
      } satisfies SolicitudViewer,
    };
  }

  const seller = await getSellerSessionUser(user);
  if (!seller) return { user, seller: null, viewer: null };
  return {
    user,
    seller,
    viewer: {
      kind: seller.tipoPerfil === "SUPERVISOR" ? "SUPERVISOR" : "SELLER",
      userId: user.id,
      aliadoId: user.aliadoId,
      sedeId: seller.sedeId,
      vendedorId: seller.id,
    } satisfies SolicitudViewer,
  };
}

export async function GET(req: Request) {
  try {
    const access = await getViewer();
    if (!access) return response({ error: "No autenticado" }, { status: 401 });
    if (!access.viewer) {
      return response(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    const filters = normalizeSolicitudFilters(new URL(req.url).searchParams);
    if (filters.id) {
      const item = await getSolicitudDetail({ viewer: access.viewer, filters });
      if (!item) return response({ error: "Solicitud no encontrada" }, { status: 404 });
      return response({ ok: true, item });
    }

    const result = await listSolicitudes({ viewer: access.viewer, filters });
    return response({ ok: true, ...result });
  } catch (error) {
    console.error("ERROR LISTANDO SOLICITUDES:", error);
    return response({ error: "No se pudo cargar el muro de solicitudes" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await getViewer();
    if (!access) return response({ error: "No autenticado" }, { status: 401 });
    if (!access.viewer) {
      return response({ error: "Acción no autorizada" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown;
      action?: unknown;
    };
    const action = String(body.action || "").trim().toUpperCase();
    const match = /^D-(\d+)$/.exec(String(body.id || "").trim().toUpperCase());
    if (action !== "DESISTIR" || !match) {
      return response({ error: "Acción inválida" }, { status: 400 });
    }

    let result = { changed: false, identityReleased: false };
    if (access.viewer.kind === "CENTRAL_ADMIN") {
      result = await desistSolicitudAsCentralAdmin({
        solicitudId: Number(match[1]),
        userId: access.user.id,
      });
    } else if (access.viewer.kind === "SELLER" && access.seller) {
      result = await desistSolicitud({
        solicitudId: Number(match[1]),
        userId: access.user.id,
        sellerId: access.seller.id,
        sedeId: access.seller.sedeId,
      });
    } else {
      return response(
        { error: "Solo el asesor titular o el administrador central pueden desistir esta solicitud" },
        { status: 403 }
      );
    }

    if (!result.changed) {
      return response(
        { error: "La solicitud ya no está disponible para desistir" },
        { status: 409 }
      );
    }
    return response({
      ok: true,
      id: body.id,
      estado: "CANCELADA",
      identityReleased: result.identityReleased,
    });
  } catch (error) {
    console.error("ERROR DESISTIENDO SOLICITUD:", error);
    return response({ error: "No se pudo desistir la solicitud" }, { status: 500 });
  }
}
