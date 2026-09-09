// Personal access metadata only. Tokens and signing secrets are never stored.
function ensureConstraint(name, definition) {
  return `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = '${name}' AND conrelid = 'public."CreditApprovalAccessLink"'::regclass) THEN
      ALTER TABLE public."CreditApprovalAccessLink" ADD CONSTRAINT "${name}" ${definition};
    END IF;
  END $$`;
}

export const approvalAccessSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalAccessLink" (
    "userId" INTEGER NOT NULL,
    "id" UUID NOT NULL,
    "credentialVersion" VARCHAR(64) NOT NULL,
    "issuedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "CreditApprovalAccessLink_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "CreditApprovalAccessLink_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES public."Usuario" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CreditApprovalAccessLink_issuedByUserId_fkey"
      FOREIGN KEY ("issuedByUserId") REFERENCES public."Usuario" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  // Also correct Prisma-first default expressions without rewriting any rows.
  `ALTER TABLE public."CreditApprovalAccessLink"
    ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  ensureConstraint("CreditApprovalAccessLink_pkey", 'PRIMARY KEY ("userId")'),
  ensureConstraint("CreditApprovalAccessLink_userId_fkey",
    'FOREIGN KEY ("userId") REFERENCES public."Usuario" ("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
  ensureConstraint("CreditApprovalAccessLink_issuedByUserId_fkey",
    'FOREIGN KEY ("issuedByUserId") REFERENCES public."Usuario" ("id") ON DELETE RESTRICT ON UPDATE CASCADE'),
  ensureConstraint("CreditApprovalAccessLink_credentialVersion_check",
    'CHECK (LENGTH(BTRIM("credentialVersion")) BETWEEN 1 AND 64)'),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalAccessLink_id_key"
    ON public."CreditApprovalAccessLink" ("id")`,
];

async function assertCompatibleColumns(client) {
  const result = await client.query(`SELECT column_name, data_type, is_nullable,
      character_maximum_length, datetime_precision
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='CreditApprovalAccessLink'`);
  const columns = new Map(result.rows.map(row => [row.column_name, row]));
  const expected = [
    ["userId", "integer", "NO"],
    ["id", "uuid", "NO"],
    ["credentialVersion", "character varying", "NO", 64],
    ["issuedByUserId", "integer", "NO"],
    ["createdAt", "timestamp without time zone", "NO", null, 3],
    ["revokedAt", "timestamp without time zone", "YES", null, 3],
  ];
  for (const [name, type, nullable, length, precision] of expected) {
    const actual = columns.get(name);
    if (!actual || actual.data_type !== type || actual.is_nullable !== nullable ||
      (length != null && Number(actual.character_maximum_length) !== length) ||
      (precision != null && Number(actual.datetime_precision) !== precision)) {
      throw new Error("APPROVAL_ACCESS_SCHEMA_INCOMPATIBLE");
    }
  }
}

export async function installApprovalAccessSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-approval-access-schema'))");
    for (const statement of approvalAccessSchemaStatements) await client.query(statement);
    await assertCompatibleColumns(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
