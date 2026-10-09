export type QueryCounts = {
  originalQueries: number;
  approved: number;
  rejected: number;
  notEvaluated: number;
  reusedAssessments: number;
};

export type QueryDetailInput = QueryCounts & {
  allyId: number | null;
  siteId: number;
  siteName: string;
  sellerKey: string;
  sellerName: string;
};

export type QueryRankingRow = QueryCounts & {
  allyId: number | null;
  allyName: string;
  key: string;
  name: string;
};

export function aggregateQueryDetails(
  input: readonly QueryDetailInput[],
  allies: readonly { allyId: number | null; allyName: string }[]
) {
  const names = new Map(allies.map(a => [a.allyId, a.allyName]));
  const sites = new Map<string, QueryRankingRow>();
  const sellers = new Map<string, QueryRankingRow>();
  const counts = new Map<number | null, QueryCounts>();
  const empty = (): QueryCounts => ({ originalQueries: 0, approved: 0, rejected: 0, notEvaluated: 0, reusedAssessments: 0 });
  const add = (target: QueryCounts, row: QueryCounts) => {
    for (const key of Object.keys(empty()) as (keyof QueryCounts)[]) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("INVALID_QUERY_COUNT");
      target[key] += row[key];
    }
  };
  for (const row of input) {
    if (!names.has(row.allyId)) continue;
    if (row.originalQueries !== row.approved + row.rejected + row.notEvaluated) throw new Error("QUERY_COUNTS_DO_NOT_RECONCILE");
    const total = counts.get(row.allyId) ?? empty();
    add(total, row); counts.set(row.allyId, total);
    for (const [map, id, name] of [[sites, String(row.siteId), row.siteName], [sellers, row.sellerKey, row.sellerName]] as const) {
      const key = `${row.allyId}:${id}`;
      const item = map.get(key) ?? { ...empty(), allyId: row.allyId, allyName: names.get(row.allyId)!, key, name };
      add(item, row); map.set(key, item);
    }
  }
  const sort = (map: Map<string, QueryRankingRow>) => [...map.values()].sort((a,b) => a.allyName.localeCompare(b.allyName, "es-CO") || b.originalQueries - a.originalQueries || a.name.localeCompare(b.name, "es-CO") || a.key.localeCompare(b.key));
  const siteRows = sort(sites), sellerRows = sort(sellers);
  // Keep every tie. Zero-query rows must never become ranking winners.
  const leaders = allies.map(a => {
    const top = (rows: QueryRankingRow[]) => {
      const eligible = rows.filter(r => r.allyId === a.allyId && r.originalQueries > 0);
      return eligible.filter(r => r.originalQueries === eligible[0]?.originalQueries);
    };
    return { ...a, sites: top(siteRows), sellers: top(sellerRows) };
  });
  return { counts, sites: siteRows, sellers: sellerRows, leaders };
}
