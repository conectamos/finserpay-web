export type DataCreditoAllyBranchQuotaBranch = {
  id: number;
  name: string;
  active: boolean;
  dailyQueryLimit: number | null;
  usedToday: number;
  remainingToday: number;
};

/** Own-ally quota data only. Never includes policy settings or other allies. */
export type DataCreditoAllyBranchQuota = {
  id: number;
  name: string;
  dailyQueryLimit: number | null;
  branchQuotaEnabled: boolean;
  dailyQueriesUsed: number;
  dailyQueriesRemaining: number | null;
  dailyQuotaResetsAt: string | null;
  branches: DataCreditoAllyBranchQuotaBranch[];
};
