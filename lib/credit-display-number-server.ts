import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { confirmedSadminNumber } from "@/lib/credit-display-number";

type NumberDatabase = {
  creditSadminRegistration: {
    findMany(input: {
      where: { creditoId: { in: number[] }; numeroCreditoConfirmado: true; numeroCredito: { not: null } };
      select: { creditoId: true; numeroCredito: true; numeroCreditoConfirmado: true };
    }): Promise<Array<{ creditoId: number; numeroCredito: string | null; numeroCreditoConfirmado: boolean }>>;
  };
};

/** Call only with IDs already selected through the caller's access scope. */
export async function getCreditDisplayNumbers(ids: number[], database: NumberDatabase = prisma) {
  const selected = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))];
  const numbers = new Map<number, string>();
  for (let offset = 0; offset < selected.length; offset += 2000) {
    const rows = await database.creditSadminRegistration.findMany({
      where: { creditoId: { in: selected.slice(offset, offset + 2000) }, numeroCreditoConfirmado: true, numeroCredito: { not: null } },
      select: { creditoId: true, numeroCredito: true, numeroCreditoConfirmado: true },
    });
    for (const row of rows) {
      const number = confirmedSadminNumber(row);
      if (number) numbers.set(row.creditoId, number);
    }
  }
  return numbers;
}

export function withCreditDisplayNumber<T extends { id: number; folio?: string | null }>(credit: T, numbers: ReadonlyMap<number, string>) {
  return { ...credit, numeroCreditoVisible: numbers.get(credit.id) || credit.folio || "Sin folio" };
}

export async function withSettlementDisplayNumbers<T extends {
  items: Array<{ creditoId: number; folio: string }>;
  recaudos: Array<{ creditoId: number; folio: string }>;
}>(settlements: T[]) {
  const numbers = await getCreditDisplayNumbers(settlements.flatMap(item => [...item.items, ...item.recaudos].map(line => line.creditoId)));
  return settlements.map(settlement => ({
    ...settlement,
    items: settlement.items.map(line => ({ ...line, numeroCreditoVisible: numbers.get(line.creditoId) || line.folio })),
    recaudos: settlement.recaudos.map(line => ({ ...line, numeroCreditoVisible: numbers.get(line.creditoId) || line.folio })),
  }));
}

/** Use inside the existing authorized query; this condition grants no access by itself. */
export function creditNumberSearchWhere(search: string): Prisma.CreditoWhereInput {
  return { OR: [
    { folio: { contains: search, mode: "insensitive" } },
    { registroSadmin: { is: { numeroCreditoConfirmado: true, numeroCredito: { contains: search, mode: "insensitive" } } } },
  ] };
}
