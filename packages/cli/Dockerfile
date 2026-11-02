FROM node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS core

RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends ca-certificates && \
  test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package* pnpm* .pnpmfile.cjs ./
COPY ./packages ./packages/
RUN npm install --global corepack@latest && corepack enable pnpm && \
  pnpm --filter @frameleaf/sdk --filter @frameleaf/cli install --frozen-lockfile && \
  pnpm --filter @frameleaf/sdk --filter @frameleaf/cli build

WORKDIR /import

ENTRYPOINT ["node", "/usr/src/app/packages/cli/dist"]
