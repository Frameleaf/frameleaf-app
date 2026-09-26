# BEGIN frameleaf-server-base
# Frameleaf builds its own server base instead of pulling a prebuilt one. The stages between these
# markers reproduce the base-server-dev image from immich-app/base-images tag 202609151314 (commit
# 0f4c144d44c0556f8a7fc9143f82a176986369fc, AGPL-3.0). The scripts, version pins and patches it runs
# are vendored in server/base-image. server/Dockerfile and server/Dockerfile.dev carry identical
# copies of this block; docker/frameleaf-delivery.test.mjs fails if they drift apart.
FROM node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590 AS base-server-build
ARG DEBIAN_FRONTEND=noninteractive

WORKDIR /usr/src/base-image

ENV LD_LIBRARY_PATH=/usr/local/lib \
  LD_RUN_PATH=/usr/local/lib

COPY server/base-image/configure-apt.sh ./

# Install ca-certificates first, then set up the PostgreSQL client repository
RUN ./configure-apt.sh && \
  apt-get update && \
  apt-get install --no-install-recommends -yqq ca-certificates && \
  mkdir -p /usr/share/postgresql-common/pgdg

# PGDG signing key (fingerprint B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8), pinned by checksum.
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 --chmod=644 https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc

RUN . /etc/os-release && \
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
  apt-get update && \
  apt-get install --no-install-recommends -yqq \
  git \
  autoconf \
  automake \
  libtool \
  libltdl-dev \
  build-essential \
  cmake \
  jq \
  libbrotli-dev \
  # libde265 v1.0.16 includes a fix for HDR images. Packages taken from Debian testing (this one and
  # libmimalloc3 in the production stage) float with that suite, as they did upstream; every other
  # compiled input is pinned by revision or checksum.
  libde265-dev/testing \
  libexif-dev \
  libexpat1-dev \
  libglib2.0-dev \
  libgsf-1-dev \
  libmimalloc3 \
  # libjpeg62-turbo-dev is only for building libvips; the final image uses jpegli (/usr/local/lib/libjpeg.so.62)
  libjpeg62-turbo-dev \
  liblcms2-dev \
  librsvg2-dev \
  libspng-dev \
  meson \
  ninja-build \
  pkg-config \
  wget \
  unzip \
  zlib1g \
  postgresql-client-14 \
  postgresql-client-15 \
  postgresql-client-16 \
  postgresql-client-17 \
  postgresql-client-18 \
  tini \
  make \
  ocl-icd-libopencl1 \
  libopenmpt0 \
  libbluray2 \
  libvpx9 \
  libzvbi0 \
  libmp3lame0 \
  libopus0 \
  libtheora0 \
  libvorbis0a \
  libvorbisenc2 \
  libx264-164 \
  libdav1d-dev \
  libhwy-dev \
  libwebp-dev \
  libio-compress-brotli-perl \
  libaom-dev

FROM base-server-build AS base-server-geodata

# Reverse-geocoding data from a fixed snapshot: GeoNames publishes no versioned files, so these are the
# Internet Archive captures of its daily dumps, each pinned by checksum. The recorded date is the
# snapshot's, not the build's, so every build (amd64 and arm64 alike) ships identical data and a new image
# only re-imports geodata when this snapshot changes. Refresh all five inputs and GEODATA_DATE together.
ARG GEODATA_DATE=2026-09-11T00:21:05+00:00
ADD --checksum=sha256:c4ec45f18921948fc2bce5b1e89bcef98c0236c7bea986918999b3e3f71bd3ef https://web.archive.org/web/20260911002105id_/https://download.geonames.org/export/dump/cities500.zip /build/geodata/cities500.zip
ADD --checksum=sha256:590651498043f674accda2b7f46d21286cda0e290b02f8561c5005eee9a5448c --chmod=444 https://web.archive.org/web/20260911002039id_/https://download.geonames.org/export/dump/admin1CodesASCII.txt /build/geodata/admin1CodesASCII.txt
ADD --checksum=sha256:fe8196f90676f40a8845f24cc0687dadc668fe8c0f9de6458da65fda50b48aba --chmod=444 https://web.archive.org/web/20260911002112id_/https://download.geonames.org/export/dump/admin2Codes.txt /build/geodata/admin2Codes.txt
ADD --checksum=sha256:93bafc525813f22e4711ff9ed6d626343094ce48c26388dc7c49189b3d7d5512 --chmod=444 https://web.archive.org/web/20260913000631id_/https://download.geonames.org/export/dump/countryInfo.txt /build/geodata/countryInfo.txt
ADD --checksum=sha256:239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255 --chmod=444 https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson /build/geodata/ne_10m_admin_0_countries.geojson

RUN umask 0333 && unzip /build/geodata/cities500.zip -d /build/geodata/ && \
  rm /build/geodata/cities500.zip && printf '%s' "$GEODATA_DATE" > /build/geodata/geodata-date.txt

FROM base-server-build AS base-server-jpegli

COPY server/base-image/sources/jpegli.json server/base-image/sources/jpegli.sh ./
COPY server/base-image/sources/jpegli-patches/ ./jpegli-patches/
RUN ./jpegli.sh

FROM base-server-build AS base-server-libheif

COPY server/base-image/sources/libheif.json server/base-image/sources/libheif.sh ./
RUN ./libheif.sh

FROM base-server-build AS base-server-libjxl

COPY server/base-image/sources/libjxl.json server/base-image/sources/libjxl.sh ./
RUN ./libjxl.sh

FROM base-server-build AS base-server-libraw

COPY server/base-image/sources/libraw.json server/base-image/sources/libraw.sh ./
RUN ./libraw.sh

FROM base-server-libraw AS base-server-imagemagick

COPY --from=base-server-libheif /usr/local/lib/ /usr/local/lib/libheif/
COPY --from=base-server-libheif /usr/local/include/libheif/ /usr/local/include/libheif/

COPY --from=base-server-libjxl /usr/local/lib/ /usr/local/lib/libjxl/
COPY --from=base-server-libjxl /usr/local/include/jxl/ /usr/local/include/jxl/

COPY --from=base-server-jpegli /usr/local/lib/ /usr/local/lib/jpegli/
COPY --from=base-server-jpegli /usr/local/include/jconfig.h /usr/local/include/jmorecfg.h /usr/local/include/jpeglib.h /usr/local/include/

# COPY resolves symlinks unless copying the enclosing folder, so this is a workaround to get the correct result.
RUN cp -r /usr/local/lib/libheif/libheif* /usr/local/lib/libjxl/libjxl* /usr/local/lib/jpegli/libjpeg.so* /usr/local/lib && \
  mv /usr/local/lib/libheif/pkgconfig/* /usr/local/lib/libjxl/pkgconfig/* /usr/local/lib/pkgconfig && \
  rm -r /usr/local/lib/libheif /usr/local/lib/libjxl /usr/local/lib/jpegli

COPY server/base-image/sources/imagemagick.json server/base-image/sources/imagemagick.sh ./
RUN ./imagemagick.sh

FROM base-server-imagemagick AS base-server-libvips

COPY server/base-image/sources/libvips.json server/base-image/sources/libvips.sh ./
COPY server/base-image/sources/libvips-patches/ ./libvips-patches/
RUN ./libvips.sh

FROM base-server-build AS base-server-dev

COPY server/base-image/packages/ffmpeg.json server/base-image/packages/ffmpeg.sh ./
RUN ./ffmpeg.sh

COPY --from=base-server-libvips /usr/local/lib/ /usr/local/lib/
COPY --from=base-server-libvips /usr/local/bin/vips* /usr/local/bin/
COPY --from=base-server-libvips /usr/local/include/vips/ /usr/local/include/vips/
COPY --from=base-server-geodata /build/geodata /build/geodata

ENV LD_LIBRARY_PATH=/usr/lib/wsl/lib

RUN ldconfig /usr/local/lib

# Record the exact source revisions and package versions this base was built from.
COPY server/base-image/packages/ ./packages/
COPY server/base-image/sources/ ./sources/
RUN jq -s '.' packages/*.json > /tmp/packages.json && \
  jq -s '.' sources/*.json > /tmp/sources.json && \
  jq -n \
  --slurpfile sources /tmp/sources.json \
  --slurpfile packages /tmp/packages.json \
  '{sources: $sources[0], packages: $packages[0]}' \
  > /build/build-lock.json && \
  rm -f /tmp/packages.json /tmp/sources.json

WORKDIR /usr/src/app
# END frameleaf-server-base

# The production base: runtime libraries only, with the media libraries built above. It reproduces
# base-server-prod from the same base-images revision.
FROM node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590 AS base-server-prod
ARG DEBIAN_FRONTEND=noninteractive

# renovate: datasource=custom.intel-igc depName=intel/intel-graphics-compiler
ARG IGC_VERSION=2.38.2+22051
# renovate: datasource=custom.intel-opencl-icd depName=intel/compute-runtime
ARG COMPUTE_RUNTIME_VERSION=26.27.39122.11-0
# renovate: datasource=custom.intel-gmmlib depName=intel/compute-runtime
ARG GMMLIB_VERSION=22.10.0

WORKDIR /build

COPY server/base-image/configure-apt.sh server/base-image/packages/ffmpeg.json server/base-image/packages/ffmpeg.sh ./

RUN ./configure-apt.sh && \
  apt-get update && \
  apt-get install curl ca-certificates --no-install-recommends -yqq && \
  mkdir -p /usr/share/postgresql-common/pgdg

# PGDG signing key (fingerprint B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8), pinned by checksum.
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 --chmod=644 https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc

RUN . /etc/os-release && \
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
  apt-get update && \
  apt-get install --no-install-recommends -yqq \
  jq \
  libde265-0/testing \
  libexif12 \
  libexpat1 \
  libgcc-s1 \
  libglib2.0-0 \
  libgomp1 \
  libgsf-1-114 \
  liblcms2-2 \
  liblqr-1-0 \
  libltdl7 \
  libopenexr-3-1-30 \
  libopenjp2-7 \
  librsvg2-2 \
  libspng0 \
  tini \
  wget \
  zlib1g \
  ocl-icd-libopencl1 \
  postgresql-client-14 \
  postgresql-client-15 \
  postgresql-client-16 \
  postgresql-client-17 \
  postgresql-client-18 \
  libio-compress-brotli-perl \
  libwebp7 \
  libwebpdemux2 \
  libwebpmux3 \
  libhwy1t64 \
  libaom3 && \
  ./ffmpeg.sh && \
  if [ $(arch) = "x86_64" ]; then \
  # Old driver
  wget https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-core_1.0.17537.24_amd64.deb && \
  wget https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-opencl_1.0.17537.24_amd64.deb && \
  wget https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb && \
  # New driver
  IGC_TAG="${IGC_VERSION%%+*}" && \
  CR_TAG="${COMPUTE_RUNTIME_VERSION%-*}" && \
  wget "https://github.com/intel/intel-graphics-compiler/releases/download/v${IGC_TAG}/intel-igc-core-2_${IGC_VERSION}_amd64.deb" && \
  wget "https://github.com/intel/intel-graphics-compiler/releases/download/v${IGC_TAG}/intel-igc-opencl-2_${IGC_VERSION}_amd64.deb" && \
  wget "https://github.com/intel/compute-runtime/releases/download/${CR_TAG}/intel-opencl-icd_${COMPUTE_RUNTIME_VERSION}_amd64.deb" &&  \
  # Shared libigdgmm1
  wget -nv "https://github.com/intel/compute-runtime/releases/download/${CR_TAG}/libigdgmm12_${GMMLIB_VERSION}_amd64.deb" && \
  # SHA-256 digests GitHub records for these release assets; changing a driver version above needs its digest here.
  printf '%s\n' \
  'c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67  intel-igc-core_1.0.17537.24_amd64.deb' \
  'dd016400f87fa2b6a9fa9fbcca7eb4a2629174a29de679709f9bec5cede88b0e  intel-igc-opencl_1.0.17537.24_amd64.deb' \
  'bbe71e4f414259e06a10cde72c29a2bd78d41b2bb2f6f8463b1806797fe66e85  intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb' \
  '3dbcbe4e716d62e9bd43a4a476d724cf772b4581dbcdd096d70df382e7ccad7e  intel-igc-core-2_2.38.2+22051_amd64.deb' \
  'e265d191590efd5491bfbbd148c144fdd40aea51e0b57f8651130d2da20b8186  intel-igc-opencl-2_2.38.2+22051_amd64.deb' \
  '6e447a783c99fb5634df298c135a81165be07db98672df96cdf413d22f3e6ac4  intel-opencl-icd_26.27.39122.11-0_amd64.deb' \
  '6031a63d6e8a12ce61c14efc15f2c8e727061286e3820b8594e6d00615e04d54  libigdgmm12_22.10.0_amd64.deb' \
  > intel-drivers.sha256 && \
  sha256sum --strict -c intel-drivers.sha256 && \
  [ "$(ls *.deb | wc -l)" -eq 7 ] && \
  dpkg -i *.deb && \
  # intel-igc-opencl ships libopencl-clang.so and .so.14 as two identical files
  ln -sf libopencl-clang.so.14 /usr/local/lib/libopencl-clang.so; \
  fi && \
  # use shared libraries
  (cd /usr/lib/jellyfin-ffmpeg/lib && \
  rm -f libdav1d.so* libfontconfig.so* libfreetype.so* libfribidi.so* libharfbuzz.so* libigdgmm.so* libz.so*) && \
  apt-get install -t testing --no-install-recommends -yqq libmimalloc3 && \
  apt-get remove -yqq jq wget ca-certificates && \
  apt-get autoremove -yqq && \
  apt-get clean && \
  rm -rf \
  configure-apt.sh \
  ffmpeg* \
  intel-drivers.sha256 \
  *.deb \
  /var/lib/apt/lists \
  /usr/lib/$(arch)-linux-gnu/libjpeg.so* \
  /usr/share/doc/libjpeg62-turbo \
  /usr/share/lintian/overrides/libjpeg62-turbo

COPY --from=base-server-dev /usr/local/lib/ /usr/local/lib/
COPY --from=base-server-dev /build/ /build/

WORKDIR /usr/src/app

ENV LD_LIBRARY_PATH=/usr/lib/wsl/lib \
  # jellyfin-ffmpeg keeps its Vulkan ICD manifests outside the loader's default search path
  XDG_DATA_DIRS=/usr/lib/jellyfin-ffmpeg/share:/usr/local/share:/usr/share

RUN ldconfig /usr/local/lib

FROM base-server-dev AS builder
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

FROM base-server-prod AS prod

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
