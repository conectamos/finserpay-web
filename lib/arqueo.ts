export const ARQUEO_DENOMINACIONES = [
  { key: "billetes100000", label: "$100.000", valor: 100000 },
  { key: "billetes50000", label: "$50.000", valor: 50000 },
  { key: "billetes20000", label: "$20.000", valor: 20000 },
  { key: "billetes10000", label: "$10.000", valor: 10000 },
  { key: "billetes5000", label: "$5.000", valor: 5000 },
  { key: "billetes2000", label: "$2.000", valor: 2000 },
  { key: "billetes1000", label: "$1.000", valor: 1000 },
  { key: "monedas500", label: "$500", valor: 500 },
  { key: "monedas200", label: "$200", valor: 200 },
  { key: "monedas100", label: "$100", valor: 100 },
  { key: "monedas50", label: "$50", valor: 50 },
] as const;

export type ArqueoDenominacionKey = (typeof ARQUEO_DENOMINACIONES)[number]["key"];

export type ArqueoPayload = Record<ArqueoDenominacionKey, number> & {
  voucher: number;
  cheques: number;
  observacion?: string;
};

export function toSafeInt(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.trunc(parsed);
}

export function toSafeMoney(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

export function calcularTotalArqueo(payload: Partial<ArqueoPayload>) {
  const totalBilletes = ARQUEO_DENOMINACIONES.reduce((acc, item) => {
    return acc + toSafeInt(payload[item.key]) * item.valor;
  }, 0);

  return totalBilletes + toSafeMoney(payload.voucher) + toSafeMoney(payload.cheques);
}

export function clasificarArqueo(diferencia: number) {
  if (diferencia === 0) {
    return "CUADRADO";
  }

  if (diferencia > 0) {
    return "SOBRANTE";
  }

  return "FALTANTE";
}
