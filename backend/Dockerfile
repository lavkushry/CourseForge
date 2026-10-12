FROM golang:1.26.0-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/api ./cmd/api && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/seed ./cmd/seed && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/worker ./cmd/worker && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/media ./cmd/media && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/providercheck ./cmd/providercheck
FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 courseforge
COPY --from=build /out/ /usr/local/bin/
USER courseforge
EXPOSE 8090
ENTRYPOINT ["api"]
