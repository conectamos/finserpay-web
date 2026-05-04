import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  deleteCreditDocumentException,
  getEffectiveCreditSettings,
  listCreditDocumentExceptions,
  updateCreditSettings,
  upsertCreditDocumentException,
} from "@/lib/credit-settings";
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

export async function GET(req: Request) {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    const url = new URL(req.url);
    const documento = url.searchParams.get("documento") || "";
    const includeExceptions = url.searchParams.get("includeExceptions") === "true";
    const effective = await getEffectiveCreditSettings(documento);
    const exceptions =
      includeExceptions && isAdminRole(session.user.rolNombre)
        ? await listCreditDocumentExceptions()
        : undefined;

    return NextResponse.json({
      ok: true,
      settings: effective.settings,
      globalSettings: effective.globalSettings,
      documentException: effective.documentException,
      exceptions,
    });
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
      plazoMaximoCuotas: body.plazoMaximoCuotas,
      frecuenciaPago: body.frecuenciaPago,
    });
    const exceptions = await listCreditDocumentExceptions();

    return NextResponse.json({ ok: true, settings, exceptions });
  } catch (error) {
    console.error("ERROR PATCH CONFIGURACION CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo guardar la configuracion de credito" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json()) as Record<string, unknown>;
    const exception = await upsertCreditDocumentException({
      documento: body.documento,
      tasaInteresEa: body.tasaInteresEa,
      fianzaPorcentaje: body.fianzaPorcentaje,
      plazoCuotas: body.plazoCuotas,
      plazoMaximoCuotas: body.plazoMaximoCuotas,
      frecuenciaPago: body.frecuenciaPago,
      permiteMultiplesCreditos: body.permiteMultiplesCreditos,
      permiteEntregaSinVerificacion: body.permiteEntregaSinVerificacion,
      activo: body.activo,
      observacion: body.observacion,
    });
    const exceptions = await listCreditDocumentExceptions();

    return NextResponse.json({
      ok: true,
      settings: exception.effectiveSettings,
      documentException: exception,
      exceptions,
    });
  } catch (error) {
    console.error("ERROR POST CONFIGURACION CREDITO DOCUMENTO:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo guardar la excepcion por cedula",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const url = new URL(req.url);
    await deleteCreditDocumentException(url.searchParams.get("documento"));
    const exceptions = await listCreditDocumentExceptions();
    const effective = await getEffectiveCreditSettings();

    return NextResponse.json({
      ok: true,
      settings: effective.settings,
      globalSettings: effective.globalSettings,
      exceptions,
    });
  } catch (error) {
    console.error("ERROR DELETE CONFIGURACION CREDITO DOCUMENTO:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo eliminar la excepcion por cedula",
      },
      { status: 500 }
    );
  }
}
