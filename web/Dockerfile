FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29.5-alpine@sha256:1eff5a5f3fcf8431a0abb7eddf5471fec24e5e1905a2581aeacdb07a4479b92b
ENV COURSEFORGE_API_UPSTREAM=api:8080
ENV COURSEFORGE_MEDIA_UPSTREAM=api:8080
ENV COURSEFORGE_WEB_PORT=8080
# Container probes use cleartext HTTP on the listen port. TLS terminates at the
# edge; /health must never 301/302 to HTTPS or the probe fails.
ENV COURSEFORGE_WEB_SCHEME=http
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD /bin/sh -c 'wget -q -O /dev/null "${COURSEFORGE_WEB_SCHEME}://127.0.0.1:${COURSEFORGE_WEB_PORT}/health"'
