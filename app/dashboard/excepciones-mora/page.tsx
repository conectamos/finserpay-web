import { redirect } from "next/navigation";
import { requireCentralAdminDashboardAccess } from "@/lib/dashboard-access";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Excepciones de bloqueo | FINSER PAY",
  description: "Acuerdos que conservan la mora sin bloquear el dispositivo",
};

export default async function MoraExceptionsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCentralAdminDashboardAccess();
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.append(key, value);
    }
  }

  const search = query.toString();
  redirect(`/dashboard/aprobaciones/excepciones-mora${search ? `?${search}` : ""}`);
}
