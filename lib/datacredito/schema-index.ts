export type DataCreditoSchemaIndexMetadata = {
  columnNames: Array<string | null>;
  expressionDefinitions: Array<string | null>;
  isUnique: boolean;
  isValid: boolean;
  predicate: string | null;
};

export type DataCreditoSchemaIndexKey =
  | { column: string }
  | { expression: string };

export type DataCreditoSchemaIndexExpectation = {
  keys: DataCreditoSchemaIndexKey[];
  predicate: null | "PENDING_STATUS";
  unique: boolean;
};

function normalizeSqlFragment(value: string) {
  return value
    .replace(/"((?:[^"]|"")+)"/g, (_match, identifier: string) =>
      identifier.replace(/""/g, '"')
    )
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isPendingStatusPredicate(predicate: string | null) {
  if (!predicate) return false;

  const normalized = normalizeSqlFragment(predicate)
    .replace(/::(?:[a-z_][\w$]*\.)?[a-z_][\w$]*(?:\[\])?/gi, "")
    .replace(/[()]/g, "");

  return normalized === "status='pending'";
}

export function matchesDataCreditoSchemaIndex(
  index: DataCreditoSchemaIndexMetadata | undefined,
  expectation: DataCreditoSchemaIndexExpectation
) {
  if (!index?.isValid || index.isUnique !== expectation.unique) {
    return false;
  }

  if (
    index.columnNames.length !== expectation.keys.length ||
    index.expressionDefinitions.length !== expectation.keys.length
  ) {
    return false;
  }

  const keysMatch = expectation.keys.every((expected, position) => {
    const columnName = index.columnNames[position] ?? null;
    const expressionDefinition = index.expressionDefinitions[position] ?? null;

    if ("column" in expected) {
      return columnName === expected.column && expressionDefinition === null;
    }

    return (
      columnName === null &&
      expressionDefinition !== null &&
      normalizeSqlFragment(expressionDefinition) ===
        normalizeSqlFragment(expected.expression)
    );
  });

  if (!keysMatch) return false;

  return expectation.predicate === null
    ? index.predicate === null
    : isPendingStatusPredicate(index.predicate);
}
