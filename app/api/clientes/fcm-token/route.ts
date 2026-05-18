import { NextResponse } from "next/server";
import {
  isFcmConfigured,
  registerFcmToken,
} from "@/lib/fcm-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FcmTokenRequest = {
  appVersion?: string | null;
  documento?: string | null;
  platform?: string | null;
  token?: string | null;
};

async function readBody(req: Request): Promise<FcmTokenRequest> {
  try {
    return (await req.json()) as FcmTokenRequest;
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const item = await registerFcmToken({
      appVersion: body.appVersion,
      documento: body.documento || "",
      platform: body.platform || "ANDROID",
      token: body.token || "",
      userAgent: req.headers.get("user-agent"),
    });

    return NextResponse.json({
      configured: isFcmConfigured(),
      item,
      ok: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo registrar la app",
      },
      { status: 400 }
    );
  }
}
