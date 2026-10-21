import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { canManagePublicMerchants, listManagedMerchants, saveManagedMerchant } from "@/lib/public-merchants";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
async function requireManager() {
  const user = await getSessionUser();
  return canManagePublicMerchants(user) ? null : NextResponse.json({ error: user ? "Solo el administrador central puede gestionar esta sección." : "Inicia sesión para continuar." }, { status: user ? 403 : 401, headers });
}

export async function GET() {
  const denied = await requireManager();
  if (denied) return denied;
  try { return NextResponse.json({ comercios: await listManagedMerchants(prisma) }, { headers }); }
  catch { return NextResponse.json({ error: "No pudimos cargar los comercios. Intenta de nuevo." }, { status: 503, headers }); }
}

async function save(request: Request, editing: boolean) {
  const denied = await requireManager();
  if (denied) return denied;
  if (Number(request.headers.get("content-length")) > 3_100_000) return NextResponse.json({ error: "La imagen debe pesar máximo 2 MB." }, { status: 413, headers });
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 3_100_000) return NextResponse.json({ error: "La imagen debe pesar máximo 2 MB." }, { status: 413, headers });
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    body = parsed;
  } catch { return NextResponse.json({ error: "Revisa los datos del formulario." }, { status: 400, headers }); }
  try {
    const rows = await saveManagedMerchant(prisma, body, editing);
    if (!rows.length) return NextResponse.json({ error: "El comercio ya no existe. Actualiza la lista." }, { status: 404, headers });
    return NextResponse.json({ ok: true, id: rows[0].id }, { status: editing ? 200 : 201, headers });
  } catch (error) {
    // Database errors can contain infrastructure details: expose validation text only.
    const message = error instanceof Error ? error.message : "";
    const validation = /^(El nombre|Escribe|Selecciona|La imagen|No pudimos leer|El comercio no es válido|El estado|Los datos)/.test(message);
    return NextResponse.json({ error: validation ? message : "No pudimos guardar el comercio. Conservamos tus datos para reintentar." }, { status: validation ? 422 : 503, headers });
  }
}
export const POST = (request: Request) => save(request, false);
export const PATCH = (request: Request) => save(request, true);
