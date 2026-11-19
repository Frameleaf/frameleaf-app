# Fresh Frameleaf installations use one PostgreSQL 19 database. The base digest
# is a multi-platform index containing both amd64 and arm64 images.
# FL-1683: there is no official postgres:19.0 image yet and PostgreSQL's apt repository has dropped the
# RC packages, so this takes the official 19 RC 2 image (its entrypoint, users and paths) and upgrades
# its PostgreSQL 19 packages to the final 19.0 release from the same repository.
ARG POSTGRES_IMAGE=docker.io/library/postgres:19rc2-bookworm@sha256:7b1e213e9680e7838da5ea2a929427901b866e69d08735186b72bddfe73c0453
ARG PG_RELEASE=19.0-1.pgdg12+1
FROM ${POSTGRES_IMAGE} AS postgres-19
ARG PG_RELEASE
RUN apt-get update --error-on=any && \
    apt-get install -y --no-install-recommends \
      postgresql-19="${PG_RELEASE}" postgresql-client-19="${PG_RELEASE}" libpq5="${PG_RELEASE}" && \
    rm -rf /var/lib/apt/lists/* && \
    postgres --version | grep -Fx "postgres (PostgreSQL) 19.0 (Debian ${PG_RELEASE})"
ENV PG_VERSION=${PG_RELEASE}

FROM postgres-19 AS vector-build

ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential ca-certificates curl postgresql-server-dev-19="${PG_VERSION}" && \
    test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem && \
    curl --fail --location --retry 3 "https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v${PGVECTOR_VERSION}" -o /tmp/pgvector.tar.gz && \
    echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - && \
    mkdir /tmp/pgvector && tar -xzf /tmp/pgvector.tar.gz --strip-components=1 -C /tmp/pgvector && \
    make -C /tmp/pgvector OPTFLAGS="" && \
    make -C /tmp/pgvector DESTDIR=/opt/vector install

FROM postgres-19
RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends ca-certificates && \
    test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.title="frameleaf-postgres" \
      org.opencontainers.image.description="PostgreSQL 19.0 with pgvector 0.8.7 for Frameleaf" \
      org.opencontainers.image.source="https://github.com/Frameleaf/frameleaf-app" \
      org.opencontainers.image.licenses="PostgreSQL" \
      org.opencontainers.image.version="19.0-pgvector0.8.7"

COPY --from=vector-build /opt/vector/ /
COPY healthcheck.sh set-env.sh /usr/local/bin/
# PG19 uses /var/lib/postgresql/19/docker; mount its parent directory.
ENV POSTGRES_DB=frameleaf
HEALTHCHECK --interval=30s --start-interval=5s --start-period=5m CMD /usr/local/bin/healthcheck.sh
