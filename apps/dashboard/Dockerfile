# Next.js standalone output: a small image that carries only what it runs.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard
COPY tsconfig.base.json ./
RUN pnpm install --frozen-lockfile --filter @jisr/dashboard...
RUN pnpm --filter @jisr/dashboard build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000
# Jisr handles workers' personal data. Runtime telemetry is off unless a
# deployment deliberately turns it on.
ENV COPILOTKIT_TELEMETRY_DISABLED=true
COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /app/apps/dashboard/public ./apps/dashboard/public

USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
