# The gateway runs on Cloud Run with min-instances 1 and CPU always allocated,
# because the CopilotKit Channels connection is persistent.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ai/package.json packages/ai/
COPY packages/integrations/package.json packages/integrations/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile --filter @jisr/gateway...

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/gateway ./apps/gateway
COPY tsconfig.base.json tsconfig.json package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway

# Runs as a non-root user; secrets arrive from Secret Manager, never from the image.
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/gateway/src/index.ts"]
