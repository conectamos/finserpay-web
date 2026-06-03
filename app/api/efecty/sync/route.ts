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

  const { searchParams } = new URL(req.url);
  const result = await syncEfectyRecaudosFromSftp({
    dryRun: true,
    limitFiles: normalizeLimit(searchParams.get("limitFiles")),
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 207 });
}

export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const body = await readBody(req);
  const result = await syncEfectyRecaudosFromSftp({
    dryRun: parseBoolean(searchParams.get("dryRun") ?? body.dryRun, false),
    filenames: Array.isArray(body.filenames) ? body.filenames : undefined,
    limitFiles: normalizeLimit(searchParams.get("limitFiles") ?? body.limitFiles),
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 207 });
}
