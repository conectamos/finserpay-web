import "server-only";

import { getSessionUser } from "@/lib/auth";
import { resolveAllyPaymentViewerScope } from "@/lib/ally-payments-core";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

export type AllyPaymentAccess =
  | {
      ok: true;
      kind: "CENTRAL_ADMIN";
      user: SessionUser;
      allyId: null;
    }
  | {
      ok: true;
      kind: "ALLY_ADMIN";
      user: SessionUser;
      allyId: number;
    }
  | {
      ok: false;
      status: 401 | 403;
    };

export function resolveAllyPaymentAccessForUser(
  user: SessionUser | null
): AllyPaymentAccess {
  const scope = resolveAllyPaymentViewerScope({
    authenticated: Boolean(user),
    roleName: user?.rolNombre,
    allyAccessCode: user?.aliadoAccesoCodigo,
    allyAccessId: user?.aliadoAccesoId,
  });

  if (!user || scope.kind === "UNAUTHENTICATED") {
    return { ok: false, status: 401 };
  }

  if (scope.kind === "FORBIDDEN") {
    return { ok: false, status: 403 };
  }

  if (scope.kind === "CENTRAL_ADMIN") {
    return {
      ok: true,
      kind: "CENTRAL_ADMIN",
      user,
      allyId: null,
    };
  }

  return {
    ok: true,
    kind: "ALLY_ADMIN",
    user,
    allyId: scope.allyId,
  };
}

export async function getAllyPaymentAccess(): Promise<AllyPaymentAccess> {
  return resolveAllyPaymentAccessForUser(await getSessionUser());
}

export function canCreateAllyPayment(
  access: Pick<Extract<AllyPaymentAccess, { ok: true }>, "kind">
) {
  return access.kind === "CENTRAL_ADMIN";
}
