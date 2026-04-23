import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import EqualityZeroTouchConsole from "./equality-zero-touch-console";

export const metadata = {
  title: "Zero Touch | FINSER PAY",
  description: "Consola remota para Equality HBM Zero Touch",
};

export default async function EqualityPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  return (
    <EqualityZeroTouchConsole
      canAdmin={isAdminRole(session.rolNombre)}
      roleName={session.rolNombre}
    />
  );
}
