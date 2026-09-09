FROM node:24-bookworm-slim AS base
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

FROM node:24-bookworm-slim AS runner
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
COPY --from=builder /app/scripts/railway-cron.mjs ./scripts/railway-cron.mjs
COPY --from=builder /app/scripts/setup-datacredito.sql ./scripts/setup-datacredito.sql
COPY --from=builder /app/scripts/ensure-iphone-identity-evidence-column.mjs ./scripts/ensure-iphone-identity-evidence-column.mjs
COPY --from=builder /app/scripts/ensure-datacredito-schema.mjs ./scripts/ensure-datacredito-schema.mjs
COPY --from=builder /app/scripts/ensure-credit-amortization-schema.mjs ./scripts/ensure-credit-amortization-schema.mjs
COPY --from=builder /app/scripts/ensure-solicitudes-schema.mjs ./scripts/ensure-solicitudes-schema.mjs
COPY --from=builder /app/scripts/ensure-iphone-enrollment-schema.mjs ./scripts/ensure-iphone-enrollment-schema.mjs
COPY --from=builder /app/scripts/ensure-credit-device-replacement-schema.mjs ./scripts/ensure-credit-device-replacement-schema.mjs
COPY --from=builder /app/scripts/ensure-aliado-redescuento-schema.mjs ./scripts/ensure-aliado-redescuento-schema.mjs
COPY --from=builder /app/scripts/ensure-ally-payments-schema.mjs ./scripts/ensure-ally-payments-schema.mjs
COPY --from=builder /app/scripts/railway-predeploy.mjs ./scripts/railway-predeploy.mjs
COPY --from=builder /app/scripts/ensure-document-blacklist-schema.mjs ./scripts/ensure-document-blacklist-schema.mjs
COPY --from=builder /app/scripts/document-blacklist-schema.mjs ./scripts/document-blacklist-schema.mjs
COPY --from=builder /app/scripts/ensure-credit-approval-schema.mjs ./scripts/ensure-credit-approval-schema.mjs
COPY --from=builder /app/scripts/credit-approval-schema.mjs ./scripts/credit-approval-schema.mjs
COPY --from=builder /app/scripts/ensure-approval-access-schema.mjs ./scripts/ensure-approval-access-schema.mjs
COPY --from=builder /app/scripts/approval-access-schema.mjs ./scripts/approval-access-schema.mjs
 
COPY --from=builder /app/scripts/ensure-approval-evidence-schema.mjs ./scripts/ensure-approval-evidence-schema.mjs
COPY --from=builder /app/scripts/approval-evidence-schema.mjs ./scripts/approval-evidence-schema.mjs

COPY --from=builder /app/scripts/ensure-credit-approval-reissue-schema.mjs ./scripts/ensure-credit-approval-reissue-schema.mjs
COPY --from=builder /app/scripts/credit-approval-reissue-schema.mjs ./scripts/credit-approval-reissue-schema.mjs

COPY --from=builder /app/scripts/credit-approval-actor-schema.mjs ./scripts/credit-approval-actor-schema.mjs
COPY --from=builder /app/scripts/ensure-credit-approval-actor-schema.mjs ./scripts/ensure-credit-approval-actor-schema.mjs
COPY --from=builder /app/scripts/credit-approval-novelties-schema.mjs ./scripts/credit-approval-novelties-schema.mjs
COPY --from=builder /app/scripts/ensure-credit-approval-novelties-schema.mjs ./scripts/ensure-credit-approval-novelties-schema.mjs
COPY --from=builder /app/scripts/approval-shared-schema.mjs ./scripts/approval-shared-schema.mjs
COPY --from=builder /app/scripts/ensure-approval-shared-schema.mjs ./scripts/ensure-approval-shared-schema.mjs

EXPOSE 3000

CMD ["node", "server.js"]
