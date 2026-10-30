import { redirect } from "next/navigation";
import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import AttentionConsole from "./attention-console";

export const metadata = {
  title: "Atención | FINSER PAY",
  description: "Conversaciones de WhatsApp y seguimiento del equipo de analistas.",
};

export default async function AttentionPage() {
  const actor = await getAttentionAccess().catch((error: unknown) => {
    if (error instanceof AttentionError && error.status === 401) redirect("/aliados");
    if (error instanceof AttentionError && error.status === 403) redirect("/dashboard");
    throw error;
  });
  return <AttentionConsole actor={actor} />;
}
