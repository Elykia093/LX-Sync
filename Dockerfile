# syntax=docker/dockerfile:1.7
FROM node:24.18.0-bookworm-slim AS toolchain

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

FROM toolchain AS build
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json biome.json ./
COPY patches ./patches
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY apps ./apps
RUN pnpm build
RUN pnpm --filter @lx-sync/server deploy --prod --legacy /release/server

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=9527
ENV WEB_DIST_PATH=/app/web

WORKDIR /app
COPY --from=build --chown=node:node /release/server/package.json ./server/package.json
COPY --from=build --chown=node:node /release/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /release/server/dist ./server/dist
COPY --from=build --chown=node:node /workspace/apps/web/dist ./web

USER node
EXPOSE 9527
CMD ["node", "server/dist/index.js"]
