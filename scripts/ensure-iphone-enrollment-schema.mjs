import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema de enrolamiento iPhone."
  );
}

const client = new Client({
  application_name: "finserpay-iphone-enrollment-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const statements = [
  `
    CREATE TABLE IF NOT EXISTS public."IphoneEnrollmentAccessGrant" (
      "id" UUID NOT NULL,
      "tokenHash" CHAR(64) NOT NULL,
      "analystName" TEXT NOT NULL,
      "analystExternalId" TEXT NOT NULL,
      "issuedByUserId" INTEGER NOT NULL,
      "issuedByName" TEXT NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "consumedAt" TIMESTAMPTZ,
      "sessionIdHash" CHAR(64),
      "sessionExpiresAt" TIMESTAMPTZ,
      "revokedAt" TIMESTAMPTZ,
      "revokedByUserId" INTEGER,
      "revokedByName" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "IphoneEnrollmentAccessGrant_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "IphoneEnrollmentAccessGrant_tokenHash_key" UNIQUE ("tokenHash"),
      CONSTRAINT "IphoneEnrollmentAccessGrant_issuedBy_fkey"
        FOREIGN KEY ("issuedByUserId") REFERENCES public."Usuario" ("id")
        ON DELETE RESTRICT,
      CONSTRAINT "IphoneEnrollmentAccessGrant_revokedBy_fkey"
        FOREIGN KEY ("revokedByUserId") REFERENCES public."Usuario" ("id")
        ON DELETE SET NULL,
      CONSTRAINT "IphoneEnrollmentAccessGrant_expiry_check"
        CHECK (
          "expiresAt" > "createdAt"
          AND "expiresAt" <= "createdAt" + INTERVAL '8 hours'
        ),
      CONSTRAINT "IphoneEnrollmentAccessGrant_session_check"
        CHECK (
          ("consumedAt" IS NULL AND "sessionIdHash" IS NULL AND "sessionExpiresAt" IS NULL)
          OR
          ("consumedAt" IS NOT NULL AND "sessionIdHash" IS NOT NULL AND "sessionExpiresAt" IS NOT NULL)
        )
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS public."IphoneEnrollmentReview" (
      "id" UUID NOT NULL,
      "solicitudId" INTEGER NOT NULL,
      "decision" TEXT NOT NULL,
      "checklistVersion" TEXT NOT NULL,
      "checklist" JSONB NOT NULL,
      "documentHash" CHAR(64) NOT NULL,
      "imeiHash" CHAR(64) NOT NULL,
      "checklistHash" CHAR(64) NOT NULL,
      "analystName" TEXT NOT NULL,
      "analystExternalId" TEXT NOT NULL,
      "identityKeyVersion" TEXT NOT NULL,
      "grantId" UUID,
      "grantIssuedByUserId" INTEGER,
      "grantIssuedByName" TEXT,
      "accessFingerprint" CHAR(64) NOT NULL,
      "correlationId" UUID NOT NULL,
      "approvedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "IphoneEnrollmentReview_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "IphoneEnrollmentReview_solicitudId_key" UNIQUE ("solicitudId"),
      CONSTRAINT "IphoneEnrollmentReview_correlationId_key" UNIQUE ("correlationId"),
      CONSTRAINT "IphoneEnrollmentReview_decision_check"
        CHECK ("decision" = 'APROBADO'),
      CONSTRAINT "IphoneEnrollmentReview_solicitud_fkey"
        FOREIGN KEY ("solicitudId")
        REFERENCES public."CreditoBorrador" ("id")
        ON DELETE RESTRICT,
      CONSTRAINT "IphoneEnrollmentReview_grant_fkey"
        FOREIGN KEY ("grantId")
        REFERENCES public."IphoneEnrollmentAccessGrant" ("id")
        ON DELETE RESTRICT
    )
  `,
  `
    ALTER TABLE public."IphoneEnrollmentReview"
      ADD COLUMN IF NOT EXISTS "analystExternalId" TEXT,
      ADD COLUMN IF NOT EXISTS "identityKeyVersion" TEXT,
      ADD COLUMN IF NOT EXISTS "grantId" UUID,
      ADD COLUMN IF NOT EXISTS "grantIssuedByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "grantIssuedByName" TEXT
  `,
  `
    UPDATE public."IphoneEnrollmentReview"
    SET "analystExternalId" = COALESCE("analystExternalId", 'LEGACY'),
        "identityKeyVersion" = COALESCE("identityKeyVersion", 'legacy')
    WHERE "analystExternalId" IS NULL OR "identityKeyVersion" IS NULL
  `,
  `
    ALTER TABLE public."IphoneEnrollmentReview"
      ALTER COLUMN "analystExternalId" SET NOT NULL,
      ALTER COLUMN "identityKeyVersion" SET NOT NULL
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'IphoneEnrollmentReview_decision_check'
          AND conrelid = 'public."IphoneEnrollmentReview"'::regclass
      ) THEN
        ALTER TABLE public."IphoneEnrollmentReview"
          ADD CONSTRAINT "IphoneEnrollmentReview_decision_check"
          CHECK ("decision" = 'APROBADO');
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'IphoneEnrollmentReview_solicitud_fkey'
          AND conrelid = 'public."IphoneEnrollmentReview"'::regclass
      ) THEN
        ALTER TABLE public."IphoneEnrollmentReview"
          ADD CONSTRAINT "IphoneEnrollmentReview_solicitud_fkey"
          FOREIGN KEY ("solicitudId")
          REFERENCES public."CreditoBorrador" ("id")
          ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'IphoneEnrollmentReview_grant_fkey'
          AND conrelid = 'public."IphoneEnrollmentReview"'::regclass
      ) THEN
        ALTER TABLE public."IphoneEnrollmentReview"
          ADD CONSTRAINT "IphoneEnrollmentReview_grant_fkey"
          FOREIGN KEY ("grantId")
          REFERENCES public."IphoneEnrollmentAccessGrant" ("id")
          ON DELETE RESTRICT;
      END IF;
    END
    $$
  `,
  `
    CREATE TABLE IF NOT EXISTS public."IphoneEnrollmentPortalAttempt" (
      "id" BIGSERIAL NOT NULL,
      "clientHash" CHAR(64) NOT NULL,
      "action" TEXT NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "IphoneEnrollmentPortalAttempt_pkey" PRIMARY KEY ("id")
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "IphoneEnrollmentAccessGrant_sessionIdHash_key"
    ON public."IphoneEnrollmentAccessGrant" ("sessionIdHash")
    WHERE "sessionIdHash" IS NOT NULL
  `,
  `
    CREATE INDEX IF NOT EXISTS "IphoneEnrollmentAccessGrant_active_idx"
    ON public."IphoneEnrollmentAccessGrant" ("revokedAt", "expiresAt", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "IphoneEnrollmentPortalAttempt_client_action_created_idx"
    ON public."IphoneEnrollmentPortalAttempt" ("clientHash", "action", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "IphoneEnrollmentPortalAttempt_created_idx"
    ON public."IphoneEnrollmentPortalAttempt" ("createdAt")
  `,
];

const expectedColumns = new Map([
  [
    "IphoneEnrollmentReview",
    new Map([
      ["id", { dataType: "uuid" }],
      ["solicitudId", { dataType: "integer" }],
      ["decision", { dataType: "text" }],
      ["checklistVersion", { dataType: "text" }],
      ["checklist", { dataType: "jsonb" }],
      ["documentHash", { dataType: "character", length: 64 }],
      ["imeiHash", { dataType: "character", length: 64 }],
      ["checklistHash", { dataType: "character", length: 64 }],
      ["analystName", { dataType: "text" }],
      ["analystExternalId", { dataType: "text" }],
      ["identityKeyVersion", { dataType: "text" }],
      ["grantId", { dataType: "uuid", nullable: true }],
      ["grantIssuedByUserId", { dataType: "integer", nullable: true }],
      ["grantIssuedByName", { dataType: "text", nullable: true }],
      ["accessFingerprint", { dataType: "character", length: 64 }],
      ["correlationId", { dataType: "uuid" }],
      ["approvedAt", { dataType: "timestamp with time zone" }],
      ["createdAt", { dataType: "timestamp with time zone" }],
    ]),
  ],
  [
    "IphoneEnrollmentAccessGrant",
    new Map([
      ["id", { dataType: "uuid" }],
      ["tokenHash", { dataType: "character", length: 64 }],
      ["analystName", { dataType: "text" }],
      ["analystExternalId", { dataType: "text" }],
      ["issuedByUserId", { dataType: "integer" }],
      ["issuedByName", { dataType: "text" }],
      ["expiresAt", { dataType: "timestamp with time zone" }],
      ["consumedAt", { dataType: "timestamp with time zone", nullable: true }],
      ["sessionIdHash", { dataType: "character", length: 64, nullable: true }],
      ["sessionExpiresAt", { dataType: "timestamp with time zone", nullable: true }],
      ["revokedAt", { dataType: "timestamp with time zone", nullable: true }],
      ["revokedByUserId", { dataType: "integer", nullable: true }],
      ["revokedByName", { dataType: "text", nullable: true }],
      ["createdAt", { dataType: "timestamp with time zone" }],
    ]),
  ],
  [
    "IphoneEnrollmentPortalAttempt",
    new Map([
      ["id", { dataType: "bigint" }],
      ["clientHash", { dataType: "character", length: 64 }],
      ["action", { dataType: "text" }],
      ["createdAt", { dataType: "timestamp with time zone" }],
    ]),
  ],
]);

const expectedIndexes = new Map([
  ["IphoneEnrollmentAccessGrant_pkey", true],
  ["IphoneEnrollmentAccessGrant_tokenHash_key", true],
  ["IphoneEnrollmentAccessGrant_sessionIdHash_key", true],
  ["IphoneEnrollmentAccessGrant_active_idx", false],
  ["IphoneEnrollmentReview_pkey", true],
  ["IphoneEnrollmentReview_solicitudId_key", true],
  ["IphoneEnrollmentReview_correlationId_key", true],
  ["IphoneEnrollmentPortalAttempt_pkey", true],
  ["IphoneEnrollmentPortalAttempt_client_action_created_idx", false],
  ["IphoneEnrollmentPortalAttempt_created_idx", false],
]);

async function assertCompatibleColumns() {
  const columns = await client.query(
    `
      SELECT table_name, column_name, data_type, character_maximum_length,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'IphoneEnrollmentReview',
          'IphoneEnrollmentAccessGrant',
          'IphoneEnrollmentPortalAttempt'
        )
    `
  );
  const actualColumns = new Map(
    columns.rows.map((row) => [
      `${row.table_name}.${row.column_name}`,
      {
        dataType: row.data_type,
        length: row.character_maximum_length,
        nullable: row.is_nullable === "YES",
      },
    ])
  );

  for (const [tableName, tableColumns] of expectedColumns) {
    for (const [columnName, expected] of tableColumns) {
      const actual = actualColumns.get(`${tableName}.${columnName}`);
      if (
        !actual ||
        actual.dataType !== expected.dataType ||
        actual.nullable !== Boolean(expected.nullable) ||
        (expected.length !== undefined && actual.length !== expected.length)
      ) {
        throw new Error(
          `Definicion incompatible en ${tableName}.${columnName}.`
        );
      }
    }
  }
}

async function assertCompatibleIndexes() {
  const indexes = await client.query(
    `
      SELECT index_class.relname AS index_name,
        index_state.indisunique AS is_unique,
        index_state.indisvalid AS is_valid
      FROM pg_index index_state
      INNER JOIN pg_class index_class
        ON index_class.oid = index_state.indexrelid
      WHERE index_state.indrelid IN (
        to_regclass('public."IphoneEnrollmentAccessGrant"'),
        to_regclass('public."IphoneEnrollmentReview"'),
        to_regclass('public."IphoneEnrollmentPortalAttempt"')
      )
    `
  );
  const actualIndexes = new Map(
    indexes.rows.map((row) => [
      row.index_name,
      { unique: row.is_unique, valid: row.is_valid },
    ])
  );

  for (const [indexName, unique] of expectedIndexes) {
    const actual = actualIndexes.get(indexName);
    if (!actual?.valid || actual.unique !== unique) {
      throw new Error(`Indice incompatible para enrolamiento: ${indexName}.`);
    }
  }
}

async function assertCompatibleConstraints() {
  const constraints = await client.query(
    `
      SELECT constraint_state.conname AS constraint_name,
        constraint_state.contype::text AS constraint_type,
        constraint_state.confdeltype::text AS delete_action,
        constraint_state.convalidated AS is_valid,
        source_attribute.attname AS source_column,
        referenced_table.relname AS referenced_table,
        referenced_attribute.attname AS referenced_column,
        pg_get_constraintdef(constraint_state.oid) AS definition
      FROM pg_constraint constraint_state
      INNER JOIN pg_class source_table
        ON source_table.oid = constraint_state.conrelid
      LEFT JOIN pg_class referenced_table
        ON referenced_table.oid = constraint_state.confrelid
      LEFT JOIN LATERAL unnest(constraint_state.conkey)
        WITH ORDINALITY AS source_key(attnum, position) ON TRUE
      LEFT JOIN pg_attribute source_attribute
        ON source_attribute.attrelid = source_table.oid
        AND source_attribute.attnum = source_key.attnum
      LEFT JOIN LATERAL unnest(constraint_state.confkey)
        WITH ORDINALITY AS referenced_key(attnum, position)
        ON referenced_key.position = source_key.position
      LEFT JOIN pg_attribute referenced_attribute
        ON referenced_attribute.attrelid = referenced_table.oid
        AND referenced_attribute.attnum = referenced_key.attnum
      WHERE constraint_state.conrelid IN (
          to_regclass('public."IphoneEnrollmentReview"'),
          to_regclass('public."IphoneEnrollmentAccessGrant"')
        )
        AND constraint_state.conname IN (
          'IphoneEnrollmentReview_decision_check',
          'IphoneEnrollmentReview_solicitud_fkey',
          'IphoneEnrollmentReview_grant_fkey',
          'IphoneEnrollmentAccessGrant_issuedBy_fkey',
          'IphoneEnrollmentAccessGrant_revokedBy_fkey',
          'IphoneEnrollmentAccessGrant_expiry_check',
          'IphoneEnrollmentAccessGrant_session_check'
        )
    `
  );
  const byName = new Map(
    constraints.rows.map((row) => [row.constraint_name, row])
  );
  const decisionCheck = byName.get("IphoneEnrollmentReview_decision_check");
  const solicitudForeignKey = byName.get(
    "IphoneEnrollmentReview_solicitud_fkey"
  );
  const grantForeignKey = byName.get("IphoneEnrollmentReview_grant_fkey");
  const issuedByForeignKey = byName.get(
    "IphoneEnrollmentAccessGrant_issuedBy_fkey"
  );
  const revokedByForeignKey = byName.get(
    "IphoneEnrollmentAccessGrant_revokedBy_fkey"
  );
  const expiryCheck = byName.get(
    "IphoneEnrollmentAccessGrant_expiry_check"
  );
  const sessionCheck = byName.get(
    "IphoneEnrollmentAccessGrant_session_check"
  );

  if (
    decisionCheck?.constraint_type !== "c" ||
    !decisionCheck.is_valid ||
    !String(decisionCheck.definition || "").includes("APROBADO")
  ) {
    throw new Error(
      "Restriccion incompatible en IphoneEnrollmentReview.decision."
    );
  }

  if (
    solicitudForeignKey?.constraint_type !== "f" ||
    solicitudForeignKey.delete_action !== "r" ||
    !solicitudForeignKey.is_valid ||
    solicitudForeignKey.source_column !== "solicitudId" ||
    solicitudForeignKey.referenced_table !== "CreditoBorrador" ||
    solicitudForeignKey.referenced_column !== "id"
  ) {
    throw new Error(
      "Llave foranea incompatible en IphoneEnrollmentReview.solicitudId."
    );
  }

  const foreignKeys = [
    {
      row: grantForeignKey,
      source: "grantId",
      table: "IphoneEnrollmentAccessGrant",
      column: "id",
      deleteAction: "r",
      label: "IphoneEnrollmentReview.grantId",
    },
    {
      row: issuedByForeignKey,
      source: "issuedByUserId",
      table: "Usuario",
      column: "id",
      deleteAction: "r",
      label: "IphoneEnrollmentAccessGrant.issuedByUserId",
    },
    {
      row: revokedByForeignKey,
      source: "revokedByUserId",
      table: "Usuario",
      column: "id",
      deleteAction: "n",
      label: "IphoneEnrollmentAccessGrant.revokedByUserId",
    },
  ];
  for (const expected of foreignKeys) {
    if (
      expected.row?.constraint_type !== "f" ||
      expected.row.delete_action !== expected.deleteAction ||
      !expected.row.is_valid ||
      expected.row.source_column !== expected.source ||
      expected.row.referenced_table !== expected.table ||
      expected.row.referenced_column !== expected.column
    ) {
      throw new Error(`Llave foranea incompatible en ${expected.label}.`);
    }
  }

  if (
    expiryCheck?.constraint_type !== "c" ||
    !expiryCheck.is_valid ||
    !/(?:8 hours|08:00:00)/i.test(String(expiryCheck.definition || ""))
  ) {
    throw new Error(
      "Restriccion incompatible en IphoneEnrollmentAccessGrant.expiresAt."
    );
  }
  if (
    sessionCheck?.constraint_type !== "c" ||
    !sessionCheck.is_valid ||
    !String(sessionCheck.definition || "").includes("sessionIdHash") ||
    !String(sessionCheck.definition || "").includes("sessionExpiresAt")
  ) {
    throw new Error(
      "Restriccion incompatible en la sesion de IphoneEnrollmentAccessGrant."
    );
  }
}

async function assertNoLegacyReviews() {
  const result = await client.query(
    `
      SELECT COUNT(*)::integer AS count
      FROM public."IphoneEnrollmentReview"
      WHERE "grantId" IS NULL
        OR LOWER(COALESCE("identityKeyVersion", '')) = 'legacy'
    `
  );
  const count = Number(result.rows[0]?.count || 0);
  if (count > 0) {
    throw Object.assign(
      new Error(
        `IPHONE_ENROLLMENT_LEGACY_REVIEWS: hay ${count} revision(es) sin grant o version criptografica vigente; requieren migracion auditada antes de desplegar.`
      ),
      { code: "IPHONE_ENROLLMENT_LEGACY_REVIEWS" }
    );
  }
}

async function assertCompatibleSchema() {
  await assertCompatibleColumns();
  await assertCompatibleIndexes();
  await assertCompatibleConstraints();
  await assertNoLegacyReviews();
}

try {
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('finserpay-iphone-enrollment-schema'))"
    );
    for (const statement of statements) {
      await client.query(statement);
    }
    await assertCompatibleSchema();
    await client.query("COMMIT");
    console.log("Esquema de enrolamiento iPhone preparado correctamente.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "IPHONE_ENROLLMENT_LEGACY_REVIEWS"
  ) {
    throw error;
  }
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24)
      : "";
  throw new Error(
    "No se pudo preparar el esquema de enrolamiento iPhone" +
      (code ? ` (${code})` : "") +
      "."
  );
} finally {
  await client.end().catch(() => undefined);
}
