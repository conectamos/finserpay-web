import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { syncAllCreditMora } from "@/lib/credit-mora-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncRequestBody = {
  dryRun?: boolean | string;
  limit?: number | string;
  today?: string;
};

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || "";
}

function getExpectedToken() {
  return String(process.env.MORA_SYNC_TOKEN || process.env.CRON_SECRET || "").trim();
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();

  if (["1", "true", "yes", "si", "dry"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return fallback;
}

async function authorize(req: Request) {
  const expectedToken = getExpectedToken();
  const token =
    getBearerToken(req) ||
    req.headers.get("x-mora-sync-token")?.trim() ||
    new URL(req.url).searchParams.get("token")?.trim() ||
    "";

  if (expectedToken && token && token === expectedToken) {
    return true;
  }

  const user = await getSessionUser();
  return Boolean(user && isAdminRole(user.rolNombre));
}

async function readBody(req: Request): Promise<SyncRequestBody> {
  try {
    return (await req.json()) as SyncRequestBody;
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const report = await syncAllCreditMora({
    dryRun: true,
    limit: searchParams.get("limit") || undefined,
    today: searchParams.get("today") || null,
  });

  return NextResponse.json(report);
}

export async function POST(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const body = await readBody(req);
  const dryRun = parseBoolean(
    searchParams.get("dryRun") ?? body.dryRun,
    false
  );
  const report = await syncAllCreditMora({
    dryRun,
    limit: searchParams.get("limit") || body.limit,
    today: searchParams.get("today") || body.today || null,
  });

  return NextResponse.json(report, { status: report.ok ? 200 : 207 });
}
