import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  createFinancialAccessToken,
  clearFinancialAccessCookie,
  FINANCIAL_ACCESS_COOKIE_NAME,
  getFinancialAccessCookieOptions,
  getFinancialAccessState,
  hashFinancialPanelPassword,
  listFinancialSedes,
  updateFinancialSedePassword,
  verifyFinancialPasswordForSede,
} from "@/lib/financial-access";

export async function GET() {
  try {
    const state = await getFinancialAccessState();

    if (!state.user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    if (state.esAdmin) {
      const sedes = await listFinancialSedes();

      return NextResponse.json({
        ok: true,
        authorized: true,
        esAdmin: true,
        sedes: sedes.map((sede) => ({
          id: sede.id,
          nombre: sede.nombre,
          usaClavePredeterminada: !sede.clavePanelFinancieroHash,
        })),
      });
    }

    return NextResponse.json({
      ok: true,
      authorized: state.authorized,
      esAdmin: false,
      sede: state.sede,
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO ACCESO FINANCIERO:", error);
    return NextResponse.json(
      { error: "Error consultando acceso financiero" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    if (esAdmin) {
      return NextResponse.json({
        ok: true,
        mensaje: "Acceso autorizado",
      });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const clave = String(body.clave ?? "").trim();

    if (!clave) {
      return NextResponse.json(
        { error: "Debes ingresar la clave del panel financiero" },
        { status: 400 }
      );
    }

    const resultado = await verifyFinancialPasswordForSede(user.sedeId, clave);

    if (!resultado) {
      return NextResponse.json(
        { error: "La sede no existe" },
        { status: 404 }
      );
    }

    if (!resultado.isValid) {
      return NextResponse.json(
        { error: "Clave incorrecta" },
        { status: 401 }
      );
    }

    const response = NextResponse.json({
      ok: true,
      mensaje: "Acceso autorizado",
    });

    response.cookies.set(
      FINANCIAL_ACCESS_COOKIE_NAME,
      createFinancialAccessToken(
        user.id,
        user.sedeId,
        resultado.sede.updatedAt.toISOString()
      ),
      getFinancialAccessCookieOptions()
    );

    return response;
  } catch (error) {
    console.error("ERROR VALIDANDO CLAVE FINANCIERA:", error);
    return NextResponse.json(
      { error: "Error validando clave financiera" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    if (!esAdmin) {
      return NextResponse.json(
        { error: "Solo el administrador puede actualizar la clave financiera" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const sedeId = Number(body.sedeId ?? 0);
    const nuevaClave = String(body.nuevaClave ?? "").trim();

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede invalida" },
        { status: 400 }
      );
    }

    if (nuevaClave.length < 4) {
      return NextResponse.json(
        { error: "La nueva clave debe tener al menos 4 caracteres" },
        { status: 400 }
      );
    }

    const sede = await updateFinancialSedePassword(
      sedeId,
      hashFinancialPanelPassword(nuevaClave)
    );

    if (!sede) {
      return NextResponse.json(
        { error: "La sede no existe" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      mensaje: `Clave financiera actualizada para ${sede.nombre}`,
      sede,
    });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO CLAVE FINANCIERA:", error);
    return NextResponse.json(
      { error: "Error actualizando la clave financiera" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearFinancialAccessCookie(response);
  return response;
}
