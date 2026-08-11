export function isDataCreditoUniqueViolation(error: unknown) {
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];

  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;

    visited.add(current);
    const record = current as Record<string, unknown>;
    const code = String(record.code || record.originalCode || "");

    if (code === "23505" || code === "P2002") return true;

    // Prisma 7 wraps adapter errors as P2010 -> meta -> driverAdapterError
    // -> cause -> originalCode. Traversal is deliberately allowlisted.
    if (code === "P2010" && record.meta) pending.push(record.meta);
    for (const key of ["cause", "meta", "driverAdapterError", "originalError"]) {
      if (record[key]) pending.push(record[key]);
    }
  }

  return false;
}
