FROM node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590 AS core

WORKDIR /usr/src/app
COPY package* pnpm* .pnpmfile.cjs ./
COPY ./packages ./packages/
RUN corepack enable pnpm && \
  pnpm --filter @frameleaf/sdk --filter @frameleaf/cli install --frozen-lockfile && \
  pnpm --filter @frameleaf/sdk --filter @frameleaf/cli build

WORKDIR /import

ENTRYPOINT ["node", "/usr/src/app/packages/cli/dist"]
