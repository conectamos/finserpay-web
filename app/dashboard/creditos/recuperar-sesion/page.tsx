import SellerSessionRecoveryPage from "./recovery-client";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Recuperar sesión comercial | FINSER PAY",
  robots: { index: false, follow: false },
};

export default async function RecoveryPage({ searchParams }: {
  searchParams: Promise<{ draft?: string | string[] }>;
}) {
  const raw = (await searchParams).draft;
  const parsed = typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  const draftId = Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
  return <SellerSessionRecoveryPage key={draftId ?? "invalid"} draftId={draftId} />;
}
