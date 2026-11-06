export type CutFpdLevel = "EXCELENTE" | "BUENO" | "REGULAR" | "MALO";

export function getCutFpdLevel(rate: number): CutFpdLevel {
  if (rate <= 1) return "EXCELENTE";
  if (rate <= 4) return "BUENO";
  if (rate <= 8) return "REGULAR";
  return "MALO";
}
