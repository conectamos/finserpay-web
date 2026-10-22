# Docker Official Images mirror avoids Docker Hub's shared-builder pull limits.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS prisma-deps
RUN npm init -y \
  && npm install prisma@7.7.0 dotenv@17.2.3 pg@8.20.0 --omit=dev --ignore-scripts --package-lock=false

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/railway?schema=public
ENV SESSION_SECRET=build-only-session-secret
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=prisma-deps /app/node_modules/ ./node_modules/
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/app/generated/prisma ./app/generated/prisma
COPY --from=builder \
  /app/scripts/railway-cron.mjs \
  /app/scripts/setup-datacredito.sql \
  /app/scripts/ensure-iphone-identity-evidence-column.mjs \
  /app/scripts/ensure-datacredito-schema.mjs \
  /app/scripts/ensure-credit-amortization-schema.mjs \
  /app/scripts/ensure-credit-principal-payment-schema.mjs \
  /app/scripts/credit-principal-payment-schema.mjs \
  /app/scripts/ensure-solicitudes-schema.mjs \
  /app/scripts/ensure-solicitudes-export-schema.mjs \
  /app/scripts/ensure-iphone-enrollment-schema.mjs \
  /app/scripts/ensure-credit-device-replacement-schema.mjs \
  /app/scripts/ensure-credit-device-replacement-remission-schema.mjs \
  /app/scripts/repair-credit-device-replacement-20260918.mjs \
  /app/scripts/mass-first-payment-correction-core.mjs \
  /app/scripts/correct-historic-mass-credit-first-payments-20260925.mjs \
  /app/scripts/ensure-aliado-redescuento-schema.mjs \
  /app/scripts/ensure-ally-payments-schema.mjs \
  /app/scripts/ensure-ally-contact-schema.mjs \
  /app/scripts/ally-contact-schema.mjs \
  /app/scripts/ensure-ally-settlement-delivery-schema.mjs \
  /app/scripts/ally-settlement-delivery-schema.mjs \
  /app/scripts/credit-abono-ally-attribution-schema.mjs \
  /app/scripts/credit-ally-payment-exclusion-schema.mjs \
  /app/scripts/ally-payment-central-collection-adjustment-schema.mjs \
  /app/scripts/setup-cut-collection.sql \
  /app/scripts/ensure-cut-collection-schema.mjs \
  /app/scripts/railway-predeploy.mjs \
  /app/scripts/ensure-approval-operations-schema.mjs \
  /app/scripts/analyst-mora-schema.mjs \
  /app/scripts/ensure-analyst-mora-schema.mjs \
  /app/scripts/mora-exception-requests-schema.mjs \
  /app/scripts/ensure-mora-exception-requests-schema.mjs \
  /app/scripts/ensure-firmaseguro-draft-dispatch-schema.mjs \
  /app/scripts/ensure-document-blacklist-schema.mjs \
  /app/scripts/document-blacklist-schema.mjs \
  /app/scripts/ensure-credit-approval-schema.mjs \
  /app/scripts/credit-approval-schema.mjs \
  /app/scripts/ensure-approval-access-schema.mjs \
  /app/scripts/approval-access-schema.mjs \
  /app/scripts/ensure-approval-analyst-account-audit-schema.mjs \
  /app/scripts/approval-analyst-account-audit-schema.mjs \
  /app/scripts/ensure-approval-evidence-schema.mjs \
  /app/scripts/approval-evidence-schema.mjs \
  /app/scripts/ensure-credit-approval-reissue-schema.mjs \
  /app/scripts/credit-approval-reissue-schema.mjs \
  /app/scripts/credit-approval-actor-schema.mjs \
  /app/scripts/ensure-credit-approval-actor-schema.mjs \
  /app/scripts/credit-approval-novelties-schema.mjs \
  /app/scripts/ensure-credit-approval-novelties-schema.mjs \
  /app/scripts/approval-shared-schema.mjs \
  /app/scripts/ensure-approval-shared-schema.mjs \
  /app/scripts/credit-approval-document-refresh-schema.mjs \
  /app/scripts/ensure-credit-approval-document-refresh-schema.mjs \
  /app/scripts/credit-approval-data-schema.mjs \
  /app/scripts/ensure-credit-approval-data-schema.mjs \
  /app/scripts/credit-approval-call-schema.mjs \
  /app/scripts/ensure-credit-approval-call-schema.mjs \
  /app/scripts/credit-sadmin-schema.mjs \
  /app/scripts/ensure-credit-sadmin-schema.mjs \
  /app/scripts/second-credit-authorization-schema.mjs \
  /app/scripts/ensure-second-credit-authorization-schema.mjs \
  /app/scripts/credit-mass-imei-correction-schema.mjs \
  /app/scripts/ensure-credit-mass-imei-correction-schema.mjs \
  /app/scripts/setup-merchant-applications.sql \
  /app/scripts/ensure-merchant-applications-schema.mjs \
  /app/scripts/retry-merchant-applications.mjs \
  /app/scripts/check-merchant-application-delivery.mjs \
  /app/scripts/setup-commissions.sql \
  /app/scripts/ensure-commissions-schema.mjs \
  /app/scripts/commissions-schema-install.mjs \
  /app/scripts/credit-due-reminders-schema.mjs \
  /app/scripts/ensure-credit-due-reminders-schema.mjs \
  /app/scripts/credit-overdue-data-schema.mjs \
  /app/scripts/ensure-credit-overdue-data-schema.mjs \
  /app/scripts/cuotavencida-whatsapp-schema.mjs \
  /app/scripts/ensure-cuotavencida-whatsapp-schema.mjs \
  /app/scripts/credit-welcome-voice-schema.mjs \
  /app/scripts/ensure-credit-welcome-voice-schema.mjs \
  ./scripts/
COPY --from=builder /app/lib/solicitudes-export-schema-statements.json ./lib/solicitudes-export-schema-statements.json
COPY --from=builder /app/lib/firmaseguro-draft-administration-schema.json ./lib/firmaseguro-draft-administration-schema.json

EXPOSE 3000

CMD ["node", "server.js"]
