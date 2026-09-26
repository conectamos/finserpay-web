import type { AllyPaymentPlatform } from "./ally-payments-core";

export type PortfolioRiskBucket = "alDia" | "temprana" | "critica";

export type ProductPortfolioHealth = {
  totalBalance: number;
  healthyBalance: number;
  earlyBalance: number;
  criticalBalance: number;
  overdueBalance: number;
  healthyPercent: number;
  earlyPercent: number;
  criticalPercent: number;
  overduePercent: number;
};

type PortfolioEntry = {
  platform: AllyPaymentPlatform | null;
  bucket: PortfolioRiskBucket;
  saldoPendiente: number;
};

/** Consumes the already scoped portfolio and the general chart's risk buckets. */
export function summarizeProductPortfolioHealth(portfolio: readonly PortfolioEntry[]) {
  const result = {} as Record<AllyPaymentPlatform, ProductPortfolioHealth>;
  for (const platform of ["IPHONE", "ANDROID"] as const) {
    let healthyBalance = 0;
    let earlyBalance = 0;
    let criticalBalance = 0;
    for (const credit of portfolio) {
      if (credit.platform !== platform || credit.saldoPendiente <= 0) continue;
      if (credit.bucket === "alDia") healthyBalance += credit.saldoPendiente;
      else if (credit.bucket === "temprana") earlyBalance += credit.saldoPendiente;
      else criticalBalance += credit.saldoPendiente;
    }
    const totalBalance = healthyBalance + earlyBalance + criticalBalance;
    const overdueBalance = earlyBalance + criticalBalance;
    const percentage = (balance: number) => totalBalance > 0 ? balance / totalBalance * 100 : 0;
    result[platform] = {
      totalBalance, healthyBalance, earlyBalance, criticalBalance, overdueBalance,
      healthyPercent: percentage(healthyBalance),
      earlyPercent: percentage(earlyBalance),
      criticalPercent: percentage(criticalBalance),
      overduePercent: percentage(overdueBalance),
    };
  }
  return result;
}
