import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getCreditSettings, updateCreditSettings } from "@/lib/credit-settings";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireUser() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  return { ok: true as const, user };
}

async function requireAdmin() {
  const session = await requireUser();

  if (!session.ok) {
    return session;
  }

  if (!isAdminRole(session.user.rolNombre)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo el administrador puede modificar estos parametros" },
        { status: 403 }
      ),
    };
  }

  return session;
}

export async function GET() {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    const settings = await getCreditSettings();

    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    console.error("ERROR GET CONFIGURACION CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo cargar la configuracion de credito" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json()) as Record<string, unknown>;
    const settings = await updateCreditSettings({
      tasaInteresEa: body.tasaInteresEa,
      fianzaPorcentaje: body.fianzaPorcentaje,
      plazoCuotas: body.plazoCuotas,
      frecuenciaPago: body.frecuenciaPago,
    });

    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    console.error("ERROR PATCH CONFIGURACION CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo guardar la configuracion de credito" },
      { status: 500 }
    );
  }
}
