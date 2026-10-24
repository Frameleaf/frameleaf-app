# Anthropic OSS Scanner image (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as context, then runs the audit with no network, so every
# dependency the server, web and machine-learning tests need is fetched here. threat_model.md, next to
# this file, says how to exercise the result.
# ponytail: the production native base (libvips/libheif/ffmpeg/darktable built from source in
# server/Dockerfile) and the Studio engine are not rebuilt here; the unit suites mock them.
FROM ghcr.io/astral-sh/uv:0.13.4@sha256:9f130421e930bfbdc563c00740466603f8723158e90297d07957c2294640262b AS uv

FROM node:22.23.4-trixie
ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential python3 ffmpeg exiftool \
    && test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem \
    && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# pnpm at the version package.json pins.
RUN npm install --global corepack@latest && corepack enable pnpm && corepack install

# Node workspace: SDKs first (the server imports them), then the server itself.
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @frameleaf/sdk build \
    && pnpm --filter @frameleaf/plugin-sdk build \
    && pnpm --filter frameleaf build

# Machine-learning service: CPU extra plus the test group, Python from machine-learning/.python-version.
RUN cd machine-learning \
    && uv python install "$(cat .python-version)" \
    && uv sync --frozen --extra cpu --group test --no-progress

# Cheap unit suites so the build log shows a baseline; failures are logged, not fatal. Timeouts keep
# the whole image inside the scanner's 45-minute build limit.
RUN cd server && (timeout 900 pnpm exec vitest run --config test/vitest.config.mjs || echo "WARNING: server unit tests reported failures")
RUN cd web && (timeout 300 pnpm exec vitest run || echo "WARNING: web unit tests reported failures")
RUN cd machine-learning && (timeout 300 uv run --frozen --offline pytest -q || echo "WARNING: machine-learning tests reported failures")

# Everything is fetched; make later tool runs fail fast instead of trying the network.
ENV UV_OFFLINE=1 \
    npm_config_offline=true
