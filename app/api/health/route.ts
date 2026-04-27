import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ ok: true });
}

export function HEAD() {
  return new Response(null, { status: 200 });
}
