export type CutFpdLevel = "EXCELENTE" | "BUENO" | "REGULAR" | "MALO";

export const CUT_RISK_INDICATORS = [
  { key: "DPF 3", label: "FPD 3", hasFpdLevel: true },
  { key: "DPF 7", label: "FPD 7", hasFpdLevel: true },
  { key: "DPF 15", label: "FPD 15", hasFpdLevel: true },
  { key: "40/60", label: "FPD PRE MADURO", hasFpdLevel: false },
  { key: "FPD MADURO", label: "FPD MADURO", hasFpdLevel: false },
] as const;

export function getCutFpdLevel(rate: number): CutFpdLevel {
  if (rate <= 1) return "EXCELENTE";
  if (rate <= 4) return "BUENO";
  if (rate <= 8) return "REGULAR";
  return "MALO";
}
