ARG NODE_IMAGE=node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
FROM ${NODE_IMAGE}
WORKDIR /usr/src/app

RUN npm install --global corepack@latest && corepack enable pnpm

COPY package* pnpm* .pnpmfile.cjs ./
COPY ./packages/patches ./packages/patches/
COPY ./packages/e2e-auth-server/package.json ./packages/e2e-auth-server/

WORKDIR /usr/src/app/packages/e2e-auth-server
RUN pnpm install --frozen-lockfile

COPY ./packages/e2e-auth-server ./

EXPOSE 2286
CMD ["pnpm", "run", "start"]
