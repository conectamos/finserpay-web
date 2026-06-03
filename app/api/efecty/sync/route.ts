import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { syncEfectyRecaudosFromSftp } from "@/lib/efecty-recaudos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncBody = {
  dryRun?: boolean | string;
  filenames?: string[];
  limitFiles?: number | string;
};

function getToken() {
  return (
    process.env.EFECTY_SYNC_TOKEN ||
    process.env.MORA_SYNC_TOKEN ||
    process.env.CRON_SECRET ||
    ""
  ).trim();
}

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization") || "";

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return authorization.slice(7).trim();
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();

  if (["1", "true", "yes", "si"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeLimit(value: unknown) {
  const parsed = Math.trunc(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function sanitizeErrorMessage(error: unknown) {
  const raw =
    error instanceof Error
      ? error.message
      : "No se pudo conciliar recaudos Efecty.";
  const secrets = [
    process.env.EFECTY_SYNC_TOKEN,
    process.env.MORA_SYNC_TOKEN,
    process.env.CRON_SECRET,
    process.env.EFECTY_SFTP_PASSWORD,
    process.env.EFECTY_SFTP_PRIVATE_KEY,
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 3);

  return secrets
    .reduce((message, secret) => message.split(secret).join("[oculto]"), raw)
    .slice(0, 500);
}

function buildSyncErrorResponse(error: unknown) {
  const detail = sanitizeErrorMessage(error);

  console.error("ERROR_CONCILIANDO_EFECTY:", error);

  return NextResponse.json(
    {
      ok: false,
      error: "No se pudo conciliar recaudos Efecty.",
      detail,
    },
    { status: 500 }
  );
}

async function authorize(req: Request) {
  const token = getToken();

  if (token && getBearerToken(req) === token) {
    return true;
  }

  const user = await getSessionUser();
  return Boolean(user && isAdminRole(user.rolNombre));
}

async function readBody(req: Request): Promise<SyncBody> {
  try {
    return (await req.json()) as SyncBody;
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const result = await syncEfectyRecaudosFromSftp({
      dryRun: true,
      limitFiles: normalizeLimit(searchParams.get("limitFiles")),
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (error) {
    return buildSyncErrorResponse(error);
  }
}

export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const body = await readBody(req);
    const result = await syncEfectyRecaudosFromSftp({
      dryRun: parseBoolean(searchParams.get("dryRun") ?? body.dryRun, false),
      filenames: Array.isArray(body.filenames) ? body.filenames : undefined,
      limitFiles: normalizeLimit(searchParams.get("limitFiles") ?? body.limitFiles),
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (error) {
    return buildSyncErrorResponse(error);
  }
}
