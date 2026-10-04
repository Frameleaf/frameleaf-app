# Fresh Frameleaf installations use one PostgreSQL 19 database. The base digest
# is a multi-platform index containing both amd64 and arm64 images.
ARG POSTGRES_IMAGE=docker.io/library/postgres:19beta4-bookworm@sha256:288c9defbb13c05fed2bfb55f859f1cf65dbd600f45bc89c91efbdd8f2a1e7b9
FROM ${POSTGRES_IMAGE} AS vector-build

ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential ca-certificates curl postgresql-server-dev-19="${PG_VERSION}" && \
    curl --fail --location --retry 3 "https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v${PGVECTOR_VERSION}" -o /tmp/pgvector.tar.gz && \
    echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - && \
    mkdir /tmp/pgvector && tar -xzf /tmp/pgvector.tar.gz --strip-components=1 -C /tmp/pgvector && \
    make -C /tmp/pgvector OPTFLAGS="" && \
    make -C /tmp/pgvector DESTDIR=/opt/vector install

FROM ${POSTGRES_IMAGE}
LABEL org.opencontainers.image.title="frameleaf-postgres" \
      org.opencontainers.image.description="PostgreSQL 19 with pgvector 0.8.7 for Frameleaf" \
      org.opencontainers.image.source="https://github.com/Frameleaf/frameleaf-app" \
      org.opencontainers.image.licenses="PostgreSQL" \
      org.opencontainers.image.version="19beta4-pgvector0.8.7"

COPY --from=vector-build /opt/vector/ /
COPY healthcheck.sh set-env.sh /usr/local/bin/
# PG19 uses /var/lib/postgresql/19/docker; mount its parent directory.
ENV POSTGRES_DB=frameleaf
HEALTHCHECK --interval=30s --start-interval=5s --start-period=5m CMD /usr/local/bin/healthcheck.sh
