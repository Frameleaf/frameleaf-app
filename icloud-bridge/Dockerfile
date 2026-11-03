FROM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS build
RUN apk add --no-cache "ca-certificates>=20261020-r0"
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bridge .

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
ARG UID=10001
ARG GID=10001
RUN apk add --no-cache "ca-certificates>=20261020-r0" && addgroup -g ${GID} bridge && adduser -D -H -u ${UID} -G bridge bridge
COPY --from=build /bridge /usr/local/bin/icloud-bridge
COPY licenses/ /usr/share/licenses/icloud-bridge/
USER ${UID}:${GID}
EXPOSE 9443
ENTRYPOINT ["/usr/local/bin/icloud-bridge"]
