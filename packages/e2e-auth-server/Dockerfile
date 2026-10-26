ARG NODE_IMAGE=node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
FROM ${NODE_IMAGE}
RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends ca-certificates && \
  test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem && rm -rf /var/lib/apt/lists/*

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
