# Frameleaf PostgreSQL: PostgreSQL 14 with the VectorChord, pgvector and pgvecto.rs extensions.
#
# Published as ghcr.io/frameleaf/frameleaf-postgres:14-vectorchord0.4.3-pgvectors0.2.0. It reproduces
# the database image Frameleaf previously pulled from upstream
# (ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23),
# built from immich-app/base-images commit c5095615488fa07469b5df48a3c3e5cebeed7296 (AGPL-3.0).
# The PostgreSQL major version and every extension version are identical, so existing databases,
# backups and the official-server certification lanes stay valid. Change a version only together
# with a database migration plan: PostgreSQL major upgrades and extension downgrades are not in place.
#
# The scripts and configuration templates next to this file are vendored from the same commit.
# Every downloaded extension package is checked against the SHA-256 recorded below.

# pgvector 0.8.1 on PostgreSQL 14 (Debian bookworm), the base the upstream image was built on.
FROM docker.io/pgvector/pgvector:0.8.1-pg14-bookworm@sha256:2b8cdfaad8e380ef81202cb2df1db35a83482ca7c6f4d933d01d84c294ba64ff

# Package checksum provenance (recorded 2026-09-26):
# - VectorChord 0.4.3: the SHA-256 digests GitHub records for the tensorchord/VectorChord release assets
#   postgresql-14-vchord_0.4.3-1_{amd64,arm64}.deb.
# - pgvecto.rs 0.2.0: that release publishes no digests, so the hashes were computed by streaming
#   vectors-pg14_0.2.0_amd64.deb (asset 149326236, created 2024-02-02T05:25:42Z, updated 05:25:43Z) and
#   vectors-pg14_0.2.0_arm64.deb (asset 149327668, created 2024-02-02T05:31:28Z, updated 05:31:29Z).
#   Both packages were cross-checked against the replaced image without running it: every installed
#   file's MD5 in /var/lib/dpkg/info/vectors-pg14.md5sums, read from the extension layers of the
#   bcf63357 index (amd64 layer a4e5eae7, arm64 layer 6fb75803), matches the file in these packages.
ARG PG_MAJOR=14
ARG VECTORCHORD_TAG=0.4.3
ARG VECTORCHORD_SHA256_AMD64=2b923f4f313d150c37ed550c7b4c88a214761ff594c84bc0b3e5972cd512fb50
ARG VECTORCHORD_SHA256_ARM64=b036f05f82dc848af5d01f70ace00102c2d257cbda4965273c60f3dfce7eb482
ARG PGVECTORS_TAG=0.2.0
ARG PGVECTORS_SHA256_AMD64=f110d69156d2c409a14a58206d87925c7bc28394cd6afbc83c867422fb9aeb54
ARG PGVECTORS_SHA256_ARM64=5fe298a360b87af491ba3417c611dcae07d528a8e37050488351a900252298f9
ARG TARGETARCH

LABEL org.opencontainers.image.title="frameleaf-postgres" \
      org.opencontainers.image.description="PostgreSQL ${PG_MAJOR} with VectorChord ${VECTORCHORD_TAG}, pgvector 0.8.1 and pgvecto.rs ${PGVECTORS_TAG} for Frameleaf" \
      org.opencontainers.image.source="https://github.com/Frameleaf/frameleaf-app" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${PG_MAJOR}-vectorchord${VECTORCHORD_TAG}-pgvectors${PGVECTORS_TAG}"

ENV DB_STORAGE_TYPE=SSD

# TARGETARCH is set by BuildKit; the dpkg fallback covers the classic builder.
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "$arch" in \
      amd64) vchord_sha256="$VECTORCHORD_SHA256_AMD64"; pgvectors_sha256="$PGVECTORS_SHA256_AMD64" ;; \
      arm64) vchord_sha256="$VECTORCHORD_SHA256_ARM64"; pgvectors_sha256="$PGVECTORS_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac && \
    apt-get update && \
    apt-get install -y wget && \
    wget -nv -O /tmp/vchord.deb "https://github.com/tensorchord/VectorChord/releases/download/${VECTORCHORD_TAG}/postgresql-${PG_MAJOR}-vchord_${VECTORCHORD_TAG}-1_${arch}.deb" && \
    echo "${vchord_sha256}  /tmp/vchord.deb" | sha256sum -c - && \
    wget -nv -O /tmp/pgvectors.deb "https://github.com/tensorchord/pgvecto.rs/releases/download/v${PGVECTORS_TAG}/vectors-pg${PG_MAJOR}_${PGVECTORS_TAG}_${arch}.deb" && \
    echo "${pgvectors_sha256}  /tmp/pgvectors.deb" | sha256sum -c - && \
    apt-get install -y /tmp/pgvectors.deb && \
    apt-get install -y /tmp/vchord.deb && \
    rm -f /tmp/vchord.deb /tmp/pgvectors.deb && \
    apt-get remove -y wget && \
    apt-get autoremove -y && \
    apt-get clean -y && \
    rm -rf /var/lib/apt/lists/*

RUN chmod 1777 /etc/postgresql

COPY postgresql.hdd.conf postgresql.ssd.conf /var/postgresql-conf-tpl/
COPY immich-docker-entrypoint.sh healthcheck.sh set-env.sh /usr/local/bin/

HEALTHCHECK --interval=5m --start-interval=5s --start-period=5m CMD /usr/local/bin/healthcheck.sh

# pgvecto.rs is loaded next to VectorChord, and its schema is on the search path, as upstream does.
RUN sed -i "s/vchord.so/vchord.so, vectors.so/" /var/postgresql-conf-tpl/postgresql.*.conf && \
    sed -i "s/, public/, public, vectors/" /var/postgresql-conf-tpl/postgresql.*.conf

ENTRYPOINT ["/usr/local/bin/immich-docker-entrypoint.sh"]

CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
