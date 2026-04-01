# HLS Public Proxy

HLS Public Proxy is a lightweight Node.js proxy for HLS manifests and media segments.

It can:

- proxy `.m3u8`, `.m3u`, and related playlist URLs
- rewrite child URLs inside manifests automatically
- proxy segments and related assets
- accept normal URL input with `url=`
- accept Base64 input with `u=`
- send a custom `preferred_referer`
- use `known_origins` for referer handling
- work behind HAProxy for load balancing across multiple instances

## Routes

### `GET /`
Landing page with built-in docs and a live URL builder/test UI.

### `GET /health`
Returns runtime status and cache counters.

### `GET /proxy/manifest`
Fetches an upstream manifest, validates it, rewrites child URLs, and returns the rewritten playlist.

### `GET /proxy/segment`
Fetches and streams media segments or related assets.

## Query parameters

### `url=`
Standard URL-encoded upstream URL.

### `u=`
Base64-encoded upstream URL.

### `preferred_referer=`
Overrides the referer sent upstream.

### `known_origins=`
One or more trusted origins used for referer handling.

## Example

This example uses Base64 mode:

```text
<URL>/proxy/manifest?u=aHR0cHM6Ly8yLmNkbjJlbWJlZC5zaXRlL2NhemV0di9pbmRleC5tM3U4&preferred_referer=https%3A%2F%2F3.embedcanaisonline.com%2F&known_origins=https%3A%2F%2F2.cdn2embed.site
```

Decoded target URL:

```text
https://2.cdn2embed.site/cazetv/index.m3u8
```

## Input modes

### Base64 mode
Useful for long URLs or when combining extra query parameters.

### URL mode
Useful when you want the upstream URL to remain directly readable in the query string.

## Notes

- `/proxy/manifest` supports both `url=` and `u=`.
- `/proxy/segment` supports both `url=` and `u=`.
- If both are present, `url=` should be treated as the primary input.
- `known_origins` may be repeated multiple times in the final URL.
- `preferred_referer` should be URL-encoded.
- `u` must contain the Base64 version of the raw target URL.

## HAProxy / load balancing

This project is HAProxy-friendly and works well behind a reverse proxy or load balancer.

Typical use case:

- expose a single public endpoint with HAProxy
- run multiple proxy instances behind it
- let HAProxy distribute requests between instances
- keep the public URL stable while scaling horizontally

Because the app can derive its public base URL from forwarded headers, it fits well behind HAProxy in front of one or more containers.

## Docker

Build locally:

```bash
docker build -t hls-public-proxy .
docker run --rm -p 3000:3000 hls-public-proxy
```

Then open:

```text
http://localhost:3000/
```

Docker Compose example:

```yaml
services:
  hls-public-proxy:
    image: jeffersoncgo/hls-public-proxy:latest
    container_name: hls-public-proxy
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PORT: 3000 # Listen port inside the container
      HOST: 0.0.0.0 # Listen on all interfaces
      MAX_PARALLEL: 64 # OPTIONAL: Maximum number of parallel fetches for manifest and segments (default 64)
      # DEFAULT_REFERER: https://example.com/ # OPTIONAL: Set a default referer header for all requests
      # PROXY_BASE: https://proxy.example.com # OPTIONAL: Base URL for the proxy, used in generated manifest URLs
      # FLARESOLVERR: http://flaresolverr:8191 # OPTIONAL: URL of a FlareSolverr instance for bypassing anti-bot protections
      # SEGMENT_CACHE_MAX: 500 # OPTIONAL: Maximum number of segments to cache in memory
      # SEGMENT_CACHE_TTL_MS: 90000 # OPTIONAL: Time-to-live for cached segments in milliseconds
      # MANIFEST_CACHE_MAX: 200 # OPTIONAL: Maximum number of manifests to cache in memory
      # MANIFEST_CACHE_TTL_MS: 4000 # OPTIONAL: Time-to-live for cached manifests in milliseconds
      # SEGMENT_CACHE_MAX_BYTES: 2000000 # OPTIONAL: Maximum size in bytes for cached segments (default 2MB)
```

## UI

The landing page includes:

- current proxy base detection from the active page URL
- URL builder for manifest and segment routes
- Base64 and URL input modes
- copy/open buttons for quick testing
- the included example preloaded into the builder

## Use cases

- testing HLS manifests quickly from a browser
- rewriting manifests so child segments go through the proxy
- handling upstreams that depend on referer/origin behavior
- placing the proxy behind HAProxy for one-entrypoint deployments
