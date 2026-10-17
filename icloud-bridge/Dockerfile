FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bridge .

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
ARG UID=10001
ARG GID=10001
RUN apk add --no-cache ca-certificates && addgroup -g ${GID} bridge && adduser -D -H -u ${UID} -G bridge bridge
COPY --from=build /bridge /usr/local/bin/icloud-bridge
COPY licenses/ /usr/share/licenses/icloud-bridge/
USER ${UID}:${GID}
EXPOSE 9443
ENTRYPOINT ["/usr/local/bin/icloud-bridge"]
