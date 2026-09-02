import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  cancelCreditDeviceReplacement,
  completeCreditDeviceReplacement,
  createCreditDeviceReplacement,
  CreditDeviceReplacementError,
  getCreditDeviceReplacementOverview,
} from "@/lib/credit-device-replacement-storage";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Cookie",
    },
  });
}

function parseCreditId(value: unknown) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
) {
  const keys = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  return (
    keys.length === normalizedExpected.length &&
    keys.every((key, index) => key === normalizedExpected[index])
  );
}

function parseCreateBody(value: unknown) {
  const body = asRecord(value);
  if (
    !body ||
    !hasExactKeys(body, ["newImei", "reason"]) ||
    typeof body.newImei !== "string" ||
    typeof body.reason !== "string"
  ) {
    return null;
  }
  return { newImei: body.newImei, reason: body.reason };
}

function parsePatchBody(value: unknown) {
  const body = asRecord(value);
  if (!body || typeof body.action !== "string") return null;
  const action = body.action.trim().toUpperCase();
  if (action === "COMPLETE" && hasExactKeys(body, ["action"])) {
    return { action: "COMPLETE" as const };
  }
  if (
    action === "CANCEL" &&
    hasExactKeys(body, ["action", "reason"]) &&
    typeof body.reason === "string"
  ) {
    return { action: "CANCEL" as const, reason: body.reason };
  }
  return null;
}

async function centralAdmin() {
  const user = await getSessionUser();
  if (!user) {
    return { user: null, response: json({ error: "No autenticado" }, 401) };
  }
  if (
    !isAdminRole(user.rolNombre) ||
    !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
  ) {
    return {
      user: null,
      response: json(
        {
          error:
            "Solo el administrador central de FINSER PAY puede gestionar cambios de equipo.",
        },
        403
      ),
    };
  }
  return { user, response: null };
}

function failure(error: unknown, operation: string) {
  if (error instanceof CreditDeviceReplacementError) {
    return json(
      { ok: false, code: error.code, error: error.message },
      error.status
    );
  }
  console.error(operation, error);
  return json(
    { ok: false, error: "No fue posible gestionar el cambio de equipo." },
    500
  );
}

async function requestJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const authorization = await centralAdmin();
    if (authorization.response) return authorization.response;
    const { id } = await context.params;
    const creditId = parseCreditId(id);
    if (!creditId) {
      return json({ ok: false, error: "Crédito inválido." }, 400);
    }
    const overview = await getCreditDeviceReplacementOverview(creditId);
    return json({ ok: true, ...overview });
  } catch (error) {
    return failure(error, "GET /api/creditos/[id]/device-replacement");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const authorization = await centralAdmin();
    if (authorization.response) return authorization.response;
    const { id } = await context.params;
    const creditId = parseCreditId(id);
    if (!creditId) {
      return json({ ok: false, error: "Crédito inválido." }, 400);
    }
    const body = parseCreateBody(await requestJson(request));
    if (!body) {
      return json(
        {
          ok: false,
          error: "Envía únicamente el nuevo IMEI y el motivo del cambio.",
        },
        400
      );
    }
    await createCreditDeviceReplacement({
      creditId,
      newImei: body.newImei,
      reason: body.reason,
      actor: {
        userId: authorization.user!.id,
        name: authorization.user!.nombre,
        username: authorization.user!.usuario,
      },
    });
    const overview = await getCreditDeviceReplacementOverview(creditId);
    return json({ ok: true, ...overview }, 201);
  } catch (error) {
    return failure(error, "POST /api/creditos/[id]/device-replacement");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const authorization = await centralAdmin();
    if (authorization.response) return authorization.response;
    const { id } = await context.params;
    const creditId = parseCreditId(id);
    if (!creditId) {
      return json({ ok: false, error: "Crédito inválido." }, 400);
    }
    const body = parsePatchBody(await requestJson(request));
    if (!body) {
      return json(
        {
          ok: false,
          error:
            "La acción debe ser COMPLETE o CANCEL con su motivo correspondiente.",
        },
        400
      );
    }
    const actor = {
      userId: authorization.user!.id,
      name: authorization.user!.nombre,
      username: authorization.user!.usuario,
    };
    if (body.action === "COMPLETE") {
      await completeCreditDeviceReplacement({ creditId, actor });
    } else {
      await cancelCreditDeviceReplacement({
        creditId,
        reason: body.reason,
        actor,
      });
    }
    const overview = await getCreditDeviceReplacementOverview(creditId);
    return json({ ok: true, ...overview });
  } catch (error) {
    return failure(error, "PATCH /api/creditos/[id]/device-replacement");
  }
}
