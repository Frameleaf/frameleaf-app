FROM ghcr.io/immich-app/base-server-dev:202609151314@sha256:ba336c43615bf9fe10d27637c3baf84cfc1379482dc712c35e314946e378a076 AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  CI=1 \
  COREPACK_HOME=/tmp \
  PNPM_HOME=/buildcache/pnpm-store \
  PATH="/buildcache/pnpm-store:$PATH"

RUN npm install --global corepack@latest && \
  corepack enable pnpm && \
  pnpm config set store-dir "$PNPM_HOME"

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY ./packages/patches ./packages/patches/

FROM builder AS sdk

COPY ./packages/sdk/package.json ./packages/sdk/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/sdk install --frozen-lockfile

COPY ./packages/sdk ./packages/sdk/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/sdk build

FROM sdk AS plugin-sdk

COPY ./packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/plugin-sdk install --frozen-lockfile

COPY ./packages/plugin-sdk ./packages/plugin-sdk/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/plugin-sdk build

FROM plugin-sdk AS server

COPY ./server/package.json ./server/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich install --frozen-lockfile

COPY ./server ./server/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store \
  pnpm --filter immich build && \
  pnpm --filter immich --prod --no-optional deploy /output/server-pruned
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store \
  SHARP_FORCE_GLOBAL_LIBVIPS=true pnpm --config.verify-deps-before-run=false --dir /output/server-pruned/node_modules/sharp exec npm run build

# Studio's editor (FL-88): the pinned Freecut revision is recovered from its archive, verified file by
# file against studio/freecut-provenance.json, patched outside the snapshot, installed from the engine
# lockfile without lifecycle scripts, and built with Frameleaf's adapter into web/static/studio-engine,
# together with every licence notice it needs (attribution/, notices/).
FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS studio-engine

WORKDIR /usr/src/app
COPY ./scripts/frameleaf-studio-contracts.mjs ./scripts/frameleaf-studio-contracts.mjs
COPY ./docs/docs/developer/frameleaf-plan ./docs/docs/developer/frameleaf-plan/
COPY ./studio ./studio/
COPY ./web/src/lib/frameleaf/studio ./web/src/lib/frameleaf/studio/
RUN node studio/tools/engine.mjs prepare && \
  npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund && \
  node studio/tools/adapter.mjs build

FROM sdk AS web

COPY ./web/package.json ./web/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich-web install --frozen-lockfile

COPY ./i18n ./i18n/
# Acknowledgements and licence texts the About screen reads (FL-86).
COPY ./licenses ./licenses/
COPY ./studio/notices ./studio/notices/
COPY ./web ./web/
COPY --from=studio-engine /usr/src/app/web/static/studio-engine ./web/static/studio-engine/

ARG BUILD_ID
ENV IMMICH_BUILD=${BUILD_ID}

RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich-web build

FROM sdk AS cli

COPY ./packages/cli/package.json ./packages/cli/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/cli install --frozen-lockfile

COPY ./packages/cli ./packages/cli/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store \
  pnpm --filter @immich/cli build && \
  pnpm --filter @immich/cli --prod --no-optional deploy /output/cli-pruned

FROM plugin-sdk AS plugins

ARG TARGETPLATFORM

COPY --from=ghcr.io/jdx/mise:2026.9.9@sha256:a88f300ef4365494b88f8eefd271bb92ba467d4a41835739a714426207215730 /usr/local/bin/mise /usr/local/bin/mise

COPY ./mise.toml ./mise.toml
COPY ./mise.lock ./mise.lock
COPY ./packages/plugin-core/mise.toml ./packages/plugin-core/
ENV MISE_TRUSTED_CONFIG_PATHS=/usr/src/app/mise.toml
ENV MISE_DATA_DIR=/buildcache/mise
ENV MISE_DISABLE_TOOLS=flutter
# Harden `mise install` against transient GitHub API failures seen on the
# self-hosted build runner. Two flavors observed: "HTTP timed out" while
# fetching a version list, and "unexpected EOF" while downloading a release
# asset. Raise mise's HTTP/version-fetch timeouts above their 30s/20s defaults,
# and retry with backoff — the retry is what covers the connection-drop (EOF)
# case that a longer timeout alone cannot. Shell vars below are expanded by
# /bin/sh (RUN bodies are not subject to Docker variable substitution).
ENV MISE_HTTP_TIMEOUT=120
ENV MISE_FETCH_REMOTE_VERSIONS_TIMEOUT=120
RUN --mount=type=cache,id=mise-tools-${TARGETPLATFORM},target=/buildcache/mise \
  --mount=type=secret,id=mise_github_token,env=MISE_GITHUB_TOKEN \
  for attempt in 1 2 3 4 5; do \
  if mise install --locked github:extism/js-pdk github:webassembly/binaryen; then exit 0; fi; \
  if [ "${attempt}" -lt 5 ]; then \
  echo "mise install failed (attempt ${attempt}/5); retrying in $((attempt * 5))s" >&2; \
  sleep $((attempt * 5)); \
  fi; \
  done; \
  echo "mise install failed after 5 attempts" >&2; exit 1

COPY ./packages/plugin-core ./packages/plugin-core/

# Build plugins
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store \
  --mount=type=cache,id=mise-tools-${TARGETPLATFORM},target=/buildcache/mise \
  pnpm --filter @immich/plugin-core install --frozen-lockfile && \
  PATH="$(mise where github:extism/js-pdk):$(mise where github:webassembly/binaryen)/bin:$PATH" \
  pnpm --filter @immich/plugin-core build

FROM ghcr.io/immich-app/base-server-prod:202609151314@sha256:1d71b4254aeba9a547ed9c6a4a1acf490b5e8786d6dad2a943bd61bb0c8ab736 AS prod

WORKDIR /usr/src/app
ENV NODE_ENV=production \
  NVIDIA_DRIVER_CAPABILITIES=all \
  NVIDIA_VISIBLE_DEVICES=all

RUN apt-get update --allow-releaseinfo-change && \
  apt-get install -y --no-install-recommends libraw-bin && \
  rm -rf /var/lib/apt/lists/*

COPY --from=server /output/server-pruned ./server
COPY --from=web /usr/src/app/web/build /build/www
COPY --from=cli /output/cli-pruned ./cli
COPY --from=plugins /usr/src/app/packages/plugin-core/dist /build/plugins/immich-plugin-core/dist
COPY --from=plugins /usr/src/app/packages/plugin-core/manifest.json /build/plugins/immich-plugin-core/manifest.json
RUN ln -s ../../cli/bin/immich server/bin/immich
COPY LICENSE /licenses/LICENSE.txt
COPY LICENSE /LICENSE
# Third-party notices (FL-86): every acknowledgement with its licence text, and the Studio engine's
# notices, Freecut's MIT licence among them.
COPY ./licenses /licenses/third-party/
COPY ./studio/notices /licenses/studio/

ENV PATH="${PATH}:/usr/src/app/server/bin"

ARG BUILD_ID
ARG BUILD_IMAGE
ARG BUILD_SOURCE_REF
ARG BUILD_SOURCE_COMMIT
ARG BUILD_SOURCE_REPOSITORY=Frameleaf/frameleaf-app
ARG BUILD_IMAGE_NAME=frameleaf-server

ENV IMMICH_BUILD=${BUILD_ID}
ENV IMMICH_BUILD_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}/actions/runs/${BUILD_ID}
ENV IMMICH_BUILD_IMAGE=${BUILD_IMAGE}
ENV IMMICH_BUILD_IMAGE_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}/pkgs/container/${BUILD_IMAGE_NAME}
ENV IMMICH_REPOSITORY=${BUILD_SOURCE_REPOSITORY}
ENV IMMICH_REPOSITORY_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}
ENV IMMICH_SOURCE_REF=${BUILD_SOURCE_REF}
ENV IMMICH_SOURCE_COMMIT=${BUILD_SOURCE_COMMIT}
ENV IMMICH_SOURCE_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}/commit/${BUILD_SOURCE_COMMIT}

LABEL org.opencontainers.image.source="https://github.com/${BUILD_SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${BUILD_SOURCE_COMMIT}"

VOLUME /data
EXPOSE 2283
ENTRYPOINT ["tini", "--", "/bin/bash", "-c"]
CMD ["start.sh"]

HEALTHCHECK CMD immich-healthcheck
