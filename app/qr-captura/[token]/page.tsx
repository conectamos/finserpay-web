import { headers } from "next/headers";
import prisma from "@/lib/prisma";
import {
  resolveCaptureSessionOrigin,
  serializeCaptureSession,
} from "@/lib/credit-capture-session";
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
  const forwardedProto =
    headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const forwardedHost =
    headerStore.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headerStore.get("host") ||
    "localhost:3000";
  const requestUrl = `${forwardedProto}://${forwardedHost}/qr-captura/${token}`;
  const origin = resolveCaptureSessionOrigin(
    new Request(requestUrl, {
      headers: headerStore,
    })
  );
  const captureSession = await prisma.capturaCreditoSession.findUnique({
    where: {
      token,
    },
  });
  const initialSession = captureSession
    ? serializeCaptureSession(captureSession, origin)
    : null;

  return <MobileCaptureClient token={token} initialSession={initialSession} />;
}
