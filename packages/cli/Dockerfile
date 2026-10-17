FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS core

WORKDIR /usr/src/app
COPY package* pnpm* .pnpmfile.cjs ./
COPY ./packages ./packages/
RUN npm install --global corepack@latest && corepack enable pnpm && \
  pnpm --filter @frameleaf/sdk --filter @frameleaf/cli install --frozen-lockfile && \
  pnpm --filter @frameleaf/sdk --filter @frameleaf/cli build

WORKDIR /import

ENTRYPOINT ["node", "/usr/src/app/packages/cli/dist"]
