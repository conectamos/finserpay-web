import { headers } from "next/headers";
import prisma from "@/lib/prisma";
import { serializeCaptureSession } from "@/lib/credit-capture-session";
import MobileCaptureClient from "./mobile-capture-client";

export const dynamic = "force-dynamic";

type CapturePageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function CapturePage(props: CapturePageProps) {
  const { token } = await props.params;
  const headerStore = await headers();
  const host = headerStore.get("host") || "localhost:3000";
  const protocol = headerStore.get("x-forwarded-proto") || "http";
  const origin = `${protocol}://${host}`;
  const captureSession = await (prisma as any).capturaCreditoSession.findUnique({
    where: {
      token,
    },
  });
  const initialSession = captureSession
    ? serializeCaptureSession(captureSession, origin)
    : null;

  return <MobileCaptureClient token={token} initialSession={initialSession} />;
}
