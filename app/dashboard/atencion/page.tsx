import { redirect } from "next/navigation";
import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import AttentionConsole from "./attention-console";
import { isAttentionNotificationWorkId } from "@/lib/atencion-notification-links";

export const metadata = {
  title: "Atención | FINSER PAY",
  description: "Conversaciones de WhatsApp y seguimiento del equipo de analistas.",
};

export default async function AttentionPage({ searchParams }: { searchParams: Promise<{ tipo?: string; solicitud?: string }> }) {
  const actor = await getAttentionAccess().catch((error: unknown) => {
    if (error instanceof AttentionError && error.status === 401) redirect("/aliados");
    if (error instanceof AttentionError && error.status === 403) redirect("/dashboard");
    throw error;
  });
  const params = await searchParams;
  const initialWorkKind = params.tipo === "welcome" || params.tipo === "enrollment" ? params.tipo : null;
  const initialWorkId = initialWorkKind && isAttentionNotificationWorkId(params.solicitud) ? params.solicitud : null;
  return <AttentionConsole key={`${actor.key}:${initialWorkKind}:${initialWorkId}`} actor={actor} initialWorkKind={initialWorkKind} initialWorkId={initialWorkId} />;
}
