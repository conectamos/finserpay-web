import { NextResponse } from "next/server";
import { DocumentBlacklistError } from "@/lib/document-blacklist-core";

export function documentBlacklistErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof DocumentBlacklistError)) return null;
  return NextResponse.json({ ok: false, error: error.message, code: error.code }, {
    status: error.status,
    headers: { "Cache-Control": "no-store" },
  });
}
