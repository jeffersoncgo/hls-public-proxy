# HLS Public Proxy

HLS Public Proxy is a high-performance Node.js proxy for HLS manifests, media segments, and direct streams.

## Features

* HLS manifest proxy (`.m3u8`, `.m3u`, `.txt`)
* Automatic manifest rewriting (child URLs routed through proxy)
* Media segment proxy with smart in-memory caching
* Direct stream proxy (`/proxy/stream`) for radios, Icecast, Shoutcast, etc
* Base64 (`u=`) and URL (`url=`) input modes
* Custom `preferred_referer`
* `known_origins` support for referer logic
* Parallel fetch limiter (anti-overload)
* Optional FlareSolverr integration (Cloudflare bypass)
* Fully CORS-enabled
* HAProxy / reverse proxy friendly

---

## Routes

### `GET /`

Landing page with UI, builder, and live testing tools.

### `GET /health`

Runtime stats:

* uptime
* active requests
* cache sizes

---

### `GET /proxy/manifest`

* Fetches upstream playlist
* Validates HLS content
* Rewrites all child URLs → proxy routes
* Uses short-lived cache

---

### `GET /proxy/segment`

* Fetches segments (`.ts`, `.m4s`, `.mp4`, etc)
* Streams or caches (if small enough)
* Supports range requests

---

### `GET /proxy/stream`

* Direct passthrough streaming (no caching)
* Designed for:

  * radios (Icecast/Shoutcast)
  * live streams without HLS
* Supports:

  * range headers
  * ICY metadata

---

## Query parameters

| Param                | Description                 |
| -------------------- | --------------------------- |
| `url=`               | URL-encoded upstream        |
| `u=`                 | Base64-encoded upstream     |
| `preferred_referer=` | Overrides referer header    |
| `known_origins=`     | One or more trusted origins |

---

## Example

```text
<BASE>/proxy/manifest?u=aHR0cHM6Ly8yLmNkbjJlbWJlZC5zaXRlL2NhemV0di9pbmRleC5tM3U4&preferred_referer=https%3A%2F%2F3.embedcanaisonline.com%2F&known_origins=https%3A%2F%2F2.cdn2embed.site
```

---

## Config (CLI or ENV)

CLI overrides ENV:

```bash
node server.js --PORT=3000 --MAX_PARALLEL=64
```

### Core

| Variable           | Default | Description                      |
| ------------------ | ------- | -------------------------------- |
| `PORT`             | 3000    | Listen port                      |
| `HOST`             | 0.0.0.0 | Bind address                     |
| `MAX_PARALLEL`     | 64      | Max concurrent upstream requests |
| `FETCH_TIMEOUT_MS` | 15000   | Upstream timeout                 |

---

### Proxy behavior

| Variable          | Default                                      |
| ----------------- | -------------------------------------------- |
| `DEFAULT_REFERER` | [https://example.com/](https://example.com/) |
| `PROXY_BASE`      | auto-detected                                |

---

### Cache

| Variable                  | Default |
| ------------------------- | ------- |
| `SEGMENT_CACHE_MAX`       | 500     |
| `SEGMENT_CACHE_TTL_MS`    | 90000   |
| `SEGMENT_CACHE_MAX_BYTES` | 2MB     |
| `MANIFEST_CACHE_MAX`      | 200     |
| `MANIFEST_CACHE_TTL_MS`   | 4000    |

---

### FlareSolverr (optional)

| Variable              | Default                                              |
| --------------------- | ---------------------------------------------------- |
| `ENABLE_FLARESOLVERR` | 0                                                    |
| `FLARESOLVERR`        | [http://flaresolverr:8191](http://flaresolverr:8191) |

---

## Behavior details

### Manifest rewriting

* Converts all child URLs → proxy endpoints
* Handles:

  * relative paths
  * absolute URLs
  * mixed formats

---

### Smart caching

* **Manifest cache**

  * very short TTL
  * avoids re-fetch storms

* **Segment cache**

  * only caches small segments
  * avoids memory explosion

---

### Concurrency control

* Hard limit via `MAX_PARALLEL`
* Prevents upstream overload and local RAM spikes

---

### Stream mode

* `/proxy/stream` never caches
* Keeps connection open indefinitely
* Ideal for live audio/video streams

---

## Docker

```bash
docker build -t hls-public-proxy .
docker run -p 3000:3000 hls-public-proxy
```

---

## Docker Compose

```yaml
services:
  hls-public-proxy:
    image: jeffersoncgo/hls-public-proxy:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PROXY_BASE: https://proxy.example.com/ # Important for correct URL rewriting
      # FLARESOLVERR: http://flaresolverr:8191 # Only if theres any need of Cloudflare bypass
      # DEFAULT_REFERER: https://example.com/ # If none is provided, tries to auto-detect from upstream URL
      # PORT: 3000
      # HOST: 0.0.0.0
      # MAX_PARALLEL: 64
      # SEGMENT_CACHE_MAX: 500
      # SEGMENT_CACHE_TTL_MS: 90000
      # MANIFEST_CACHE_MAX: 200
      # MANIFEST_CACHE_TTL_MS: 4000
      # SEGMENT_CACHE_MAX_BYTES: 2000000
```

---

## Deployment notes

* Works behind HAProxy, Nginx, Traefik
* Uses forwarded headers to build public URLs
* Horizontal scaling friendly

---

## Use cases

* IPTV proxying
* bypass referer/origin restrictions
* testing HLS streams
* building streaming gateways
* load-balanced proxy clusters

---