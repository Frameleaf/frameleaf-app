ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590
FROM ${NODE_IMAGE} AS build
WORKDIR /app/manager
COPY manager/package*.json ./
RUN npm ci --ignore-scripts
COPY manager/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE}
ARG TARGETARCH
RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends docker-cli docker-compose restic openssl ca-certificates util-linux curl && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && ln -s /usr/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose \
    && docker --version && docker compose version
RUN case "$TARGETARCH" in \
      amd64) checksum=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;; \
      arm64) checksum=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;; \
      *) exit 1 ;; \
    esac \
    && curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-${TARGETARCH}" -o /usr/local/bin/cosign \
    && printf '%s  %s\n' "$checksum" /usr/local/bin/cosign | sha256sum --check --strict \
    && chmod 755 /usr/local/bin/cosign
WORKDIR /app/manager
COPY --from=build /app/manager/node_modules /app/node_modules
COPY --from=build /app/manager/build ./build
COPY --from=build /app/manager/ui/dist ./ui/dist
COPY manager/release-worker.cjs manager/entrypoint.sh ./
COPY .github/frameleaf-release.cjs .github/verify-release-bundle.cjs /app/.github/
COPY cosign.pub /app/cosign.pub
ENV NODE_ENV=production
EXPOSE 9443
ENTRYPOINT ["/bin/sh", "/app/manager/entrypoint.sh"]
