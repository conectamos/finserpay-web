import type { Metadata } from "next";
import AttentionWorkPhotoMobile from "@/app/dashboard/atencion/attention-work-photo-mobile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Fotos de la solicitud | FINSER PAY",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AttentionCapturePage() {
  return <AttentionWorkPhotoMobile />;
}
