import { resolveCreditAssignedAdministrator, resolveCreditSellerDisplay } from "@/lib/credit-assigned-seller";

export type AdminDashboardDelinquencyGroup = {
  key: string;
  name: string;
  context: string | null;
  unassigned: boolean;
  activeCredits: number;
  overdueCredits: number;
  overduePercent: number;
  overdueBalance: number;
  overdueSharePercent: number;
  overduePortfolioPercent: number;
};

export type AdminDashboardDelinquencyDetail = {
  activeCredits: number;
  overdueCredits: number;
  overduePercent: number;
  totalBalance: number;
  overdueBalance: number;
  overduePortfolioPercent: number;
  sites: AdminDashboardDelinquencyGroup[];
  sellers: AdminDashboardDelinquencyGroup[];
};

type DelinquencyCredit = {
  id: number;
  saldoPendiente: number;
  overdue: boolean;
  estado?: string | null;
  pazYSalvoEmitidoAt?: unknown;
  contratoSnapshot?: unknown;
  contratoAceptadoAt?: unknown;
  pagareAceptadoAt?: unknown;
  contratoFirmaDataUrl?: unknown;
  sedeId?: number | null;
  vendedorId?: number | null;
  vendedor?: { id?: number; nombre?: string | null; documento?: string | null } | null;
  usuario?: { id?: number; nombre?: string | null; usuario?: string | null } | null;
  sede?: {
    id?: number;
    nombre?: string | null;
    aliado?: { id?: number; nombre?: string | null } | null;
  } | null;
};

type GroupAccumulator = Omit<AdminDashboardDelinquencyGroup,
  "context" | "overduePercent" | "overdueSharePercent" | "overduePortfolioPercent"> & {
  contexts: Set<string>;
};

function ratio(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sellerIdentity(credit: DelinquencyCredit) {
  const administrator = resolveCreditAssignedAdministrator(credit);

  if (administrator) {
    return { key: `usuario:${administrator.id}`, name: administrator.nombre, unassigned: false };
  }

  if (validId(credit.vendedor?.id)) {
    return {
      key: `vendedor:${credit.vendedor.id}`,
      name: resolveCreditSellerDisplay(credit).nombre,
      unassigned: false,
    };
  }

  const snapshot = credit.contratoSnapshot && typeof credit.contratoSnapshot === "object"
    ? credit.contratoSnapshot as Record<string, unknown> : {};
  const origin = snapshot.origen && typeof snapshot.origen === "object"
    ? snapshot.origen as Record<string, unknown> : {};
  // The creator of an import batch is not the seller of its historical loans.
  if (origin.tipo === "IMPORTACION_MASIVA") {
    return { key: "unassigned", name: "Sin vendedor asignado", unassigned: true };
  }

  if (validId(credit.usuario?.id) && credit.usuario?.nombre?.trim()) {
    return {
      key: `usuario:${credit.usuario.id}`,
      name: resolveCreditSellerDisplay(credit).nombre,
      unassigned: false,
    };
  }

  return { key: "unassigned", name: "Sin vendedor asignado", unassigned: true };
}

function addGroup(
  groups: Map<string, GroupAccumulator>,
  identity: { key: string; name: string; unassigned: boolean },
  credit: DelinquencyCredit,
  context: string | null,
) {
  const group = groups.get(identity.key) || {
    ...identity,
    activeCredits: 0,
    overdueCredits: 0,
    overdueBalance: 0,
    contexts: new Set<string>(),
  };

  group.activeCredits += 1;
  if (credit.overdue) {
    group.overdueCredits += 1;
    group.overdueBalance += credit.saldoPendiente;
  }
  if (context) group.contexts.add(context);
  groups.set(identity.key, group);
}

/** Distribution of the same outstanding balances shown by portfolio health.
 * Each credit contributes once, even when several installments are overdue. */
export function summarizeDashboardDelinquency(credits: DelinquencyCredit[]): AdminDashboardDelinquencyDetail {
  const uniqueCredits = new Map<number, DelinquencyCredit>();
  for (const credit of credits) uniqueCredits.set(credit.id, credit);

  const active = [...uniqueCredits.values()].filter((credit) =>
    Number.isFinite(credit.saldoPendiente) && credit.saldoPendiente > 0 &&
    !credit.pazYSalvoEmitidoAt &&
    !["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(credit.estado || ""),
  );
  const totalBalance = active.reduce((sum, credit) => sum + credit.saldoPendiente, 0);
  const overdue = active.filter((credit) => credit.overdue);
  const overdueBalance = overdue.reduce((sum, credit) => sum + credit.saldoPendiente, 0);
  const sites = new Map<string, GroupAccumulator>();
  const sellers = new Map<string, GroupAccumulator>();

  for (const credit of active) {
    const allyName = credit.sede?.aliado?.nombre?.trim() || null;
    const siteId = credit.sede?.id ?? credit.sedeId;
    addGroup(sites, validId(siteId) ? {
      key: `sede:${siteId}`,
      name: credit.sede?.nombre?.trim() || "Sin nombre de sede",
      unassigned: false,
    } : { key: "unassigned", name: "Sin sede", unassigned: true }, credit, allyName);
    addGroup(sellers, sellerIdentity(credit), credit, allyName);
  }

  const finalize = (groups: Map<string, GroupAccumulator>) => [...groups.values()].map((group) => {
    const { contexts, ...metrics } = group;
    return {
      ...metrics,
      context: [...contexts].sort((a, b) => a.localeCompare(b, "es")).join(" · ") || null,
      overduePercent: ratio(group.overdueCredits, group.activeCredits),
      overdueSharePercent: ratio(group.overdueBalance, overdueBalance),
      overduePortfolioPercent: ratio(group.overdueBalance, totalBalance),
    };
  }).sort((a, b) =>
    b.overdueBalance - a.overdueBalance || b.overdueCredits - a.overdueCredits ||
    a.name.localeCompare(b.name, "es") || a.key.localeCompare(b.key, "es"),
  );

  return {
    activeCredits: active.length,
    overdueCredits: overdue.length,
    overduePercent: ratio(overdue.length, active.length),
    totalBalance,
    overdueBalance,
    overduePortfolioPercent: ratio(overdueBalance, totalBalance),
    sites: finalize(sites),
    sellers: finalize(sellers),
  };
}
