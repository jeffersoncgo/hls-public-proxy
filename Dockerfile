FROM node:25-alpine

LABEL org.opencontainers.image.source="https://github.com/jeffersoncgo/hls-public-proxy" \
      org.opencontainers.image.url="https://hub.docker.com/r/jeffersoncgo/hls-public-proxy" \
      org.opencontainers.image.documentation="https://github.com/jeffersoncgo/hls-public-proxy#readme" \
      org.opencontainers.image.description="Lightweight HLS reverse proxy for manifests and segments, with URL rewriting, referer/origin controls, caching, and HAProxy-friendly load balancing support."

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]