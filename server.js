'use strict';

const express = require('express');
const { URL } = require('url');
const path = require('path');
const { Readable } = require('stream');
const { LRUCache } = require('lru-cache');
const nodeFetch = require('node-fetch');

const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch : nodeFetch;

// ─────────────────────────────────────────────────────────────────
//  CLI argument parser — supports --KEY=value and --KEY value
//  CLI args take priority over environment variables.
//  Usage: node server.js --PORT=3003 --MAX_PARALLEL=64
// ─────────────────────────────────────────────────────────────────
function parseCliArgs(argv) {
  const args = {};
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg.startsWith('--')) {
      const withoutDashes = arg.slice(2);
      const eqIdx = withoutDashes.indexOf('=');
      if (eqIdx !== -1) {
        const key = withoutDashes.slice(0, eqIdx).toUpperCase();
        const value = withoutDashes.slice(eqIdx + 1);
        args[key] = value;
      } else {
        const key = withoutDashes.toUpperCase();
        const next = raw[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = 'true';
        }
      }
    }
  }
  return args;
}

const CLI = parseCliArgs(process.argv);

function cfg(key, fallback) {
  return key in CLI ? CLI[key] : (process.env[key] !== undefined ? process.env[key] : fallback);
}

const PORT                    = parseInt(cfg('PORT', '3000'), 10);
const HOST                    = cfg('HOST', '0.0.0.0');
const MAX_PARALLEL            = parseInt(cfg('MAX_PARALLEL', '64'), 10);
const DEFAULT_REFERER         = cfg('DEFAULT_REFERER', '');
const PROXY_BASE              = cfg('PROXY_BASE', '');
const ENABLE_FLARESOLVERR     = cfg('ENABLE_FLARESOLVERR', '0') === '1';
const FLARESOLVERR            = cfg('FLARESOLVERR', 'http://flaresolverr:8191');
const SEGMENT_CACHE_MAX       = parseInt(cfg('SEGMENT_CACHE_MAX', '500'), 10);
const SEGMENT_CACHE_TTL_MS    = parseInt(cfg('SEGMENT_CACHE_TTL_MS', '90000'), 10);
const MANIFEST_CACHE_MAX      = parseInt(cfg('MANIFEST_CACHE_MAX', '200'), 10);
const MANIFEST_CACHE_TTL_MS   = parseInt(cfg('MANIFEST_CACHE_TTL_MS', '4000'), 10);
const SEGMENT_CACHE_MAX_BYTES = parseInt(cfg('SEGMENT_CACHE_MAX_BYTES', '2000000'), 10);
const FETCH_TIMEOUT_MS        = parseInt(cfg('FETCH_TIMEOUT_MS', '15000'), 10);

console.log('Starting with config:', {
  PORT, HOST, MAX_PARALLEL, DEFAULT_REFERER, PROXY_BASE,
  ENABLE_FLARESOLVERR, FLARESOLVERR,
  SEGMENT_CACHE_MAX, SEGMENT_CACHE_TTL_MS,
  MANIFEST_CACHE_MAX, MANIFEST_CACHE_TTL_MS,
  SEGMENT_CACHE_MAX_BYTES, FETCH_TIMEOUT_MS,
});

// ─────────────────────────────────────────────────────────────────
//  Content-type detection helpers
// ─────────────────────────────────────────────────────────────────

const HLS_EXTENSIONS      = new Set(['.m3u8', '.m3u']);
const SEGMENT_EXTENSIONS  = new Set(['.ts', '.m4s', '.mp4', '.mp2t', '.aac', '.mp3', '.m4a', '.key']);
const SUBTITLE_EXTENSIONS = new Set(['.vtt', '.webvtt']);
// Extensions where we can't tell from URL alone — need content-type or body peek
const AMBIGUOUS_EXTENSIONS = new Set(['.txt', '.php', '.asp', '.aspx', '']);

function getUrlExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    return dot !== -1 ? pathname.slice(dot).toLowerCase() : '';
  } catch {
    return '';
  }
}

// Returns 'manifest' | 'segment' | 'stream'
function detectContentKind(url, contentType, bodyPeek) {
  const ct = (contentType || '').toLowerCase();
  const ext = getUrlExtension(url);

  // Definitive manifest signals
  if (/mpegurl|m3u/i.test(ct)) return 'manifest';
  if (HLS_EXTENSIONS.has(ext)) return 'manifest';
  if (bodyPeek && (bodyPeek.startsWith('#EXTM3U') || bodyPeek.includes('#EXT-X-'))) return 'manifest';

  // Definitive segment / file signals
  if (SEGMENT_EXTENSIONS.has(ext)) return 'segment';
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'segment';
  if (/video\/|audio\/mp4|audio\/aac|audio\/mpeg/.test(ct) && !ct.includes('mpegurl')) {
    // Could be a live stream (Icecast sends audio/mpeg with no content-length)
    return 'segment'; // handleSegment will pipe if it's large/infinite
  }

  // Default — treat as segment (gets cached if small, piped if large)
  return 'segment';
}

// ─────────────────────────────────────────────────────────────────
//  Caches
// ─────────────────────────────────────────────────────────────────

const segmentCache = new LRUCache({
  max: SEGMENT_CACHE_MAX,
  ttl: SEGMENT_CACHE_TTL_MS,
  allowStale: false,
});

const manifestCache = new LRUCache({
  max: MANIFEST_CACHE_MAX,
  ttl: MANIFEST_CACHE_TTL_MS,
  allowStale: false,
});

const flareCache = new LRUCache({
  max: 50,
  ttl: 2 * 60_000,
  allowStale: false,
});

// ─────────────────────────────────────────────────────────────────
//  Fetch helpers
// ─────────────────────────────────────────────────────────────────

let activeCount = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchLimited(url, opts = {}) {
  while (activeCount >= MAX_PARALLEL) await delay(15);
  activeCount += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...opts, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error(`Upstream timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
      timeout.isTimeout = true;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    activeCount -= 1;
  }
}

function browserHeaders(referer) {
  const ref = referer || DEFAULT_REFERER;
  let origin = ref;
  try { origin = new URL(ref).origin; } catch {}
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': ref,
    'Origin': origin,
    'Connection': 'keep-alive',
  };
}

async function getFlareCookies(targetUrl, referer) {
  if (!ENABLE_FLARESOLVERR) return '';
  const cacheKey = `${referer || ''}|${targetUrl}`;
  const cached = flareCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await fetchFn(`${FLARESOLVERR.replace(/\/$/, '')}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: referer || targetUrl, maxTimeout: 60000 }),
    });
    if (!res.ok) { flareCache.set(cacheKey, ''); return ''; }
    const json = await res.json().catch(() => null);
    const cookies = json?.solution?.cookies || json?.cookies || [];
    const cookieStr = Array.isArray(cookies)
      ? cookies.map(c => typeof c === 'string' ? c.split(';')[0] : (c?.name && c?.value ? `${c.name}=${c.value}` : '')).filter(Boolean).join('; ')
      : '';
    flareCache.set(cacheKey, cookieStr);
    return cookieStr;
  } catch {
    flareCache.set(cacheKey, '');
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────
//  Request parameter helpers
// ─────────────────────────────────────────────────────────────────
function decodeUrl(req) {
  const raw = req.query.url;
  if (!raw) return null;

  // Try base64 first: valid base64 URLs will decode to something starting with http
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  } catch {}

  // Fall back to percent-encoded or plain URL
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function decodeKnownOrigins(req, fallbackUrl) {
  let list = req.query.known_origins
    ? (Array.isArray(req.query.known_origins) ? req.query.known_origins : [req.query.known_origins])
    : [];
  list = list.map(item => { try { return decodeURIComponent(item); } catch { return item; } }).filter(Boolean);
  if (list.length === 0 && fallbackUrl) {
    try { list = [new URL(fallbackUrl).origin]; } catch {}
  }
  return list;
}

function decodePreferredReferer(req, fallbackUrl) {
  if (req.query.preferred_referer) {
    try { return decodeURIComponent(req.query.preferred_referer); } catch { return req.query.preferred_referer; }
  }
  if (fallbackUrl) {
    try { return `${new URL(fallbackUrl).origin}/`; } catch {}
  }
  return DEFAULT_REFERER;
}

function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof Readable?.fromWeb === 'function') {
    try { return Readable.fromWeb(body); } catch {}
  }
  return null;
}

function proxyOriginFromReq(req) {
  if (PROXY_BASE) return PROXY_BASE.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, ETag, Last-Modified, X-Proxy-Cache, X-Detected-As');
  res.set('Timing-Allow-Origin', '*');
}

// ─────────────────────────────────────────────────────────────────
//  Manifest rewriting
//  All child URLs go back through /proxy so they get auto-detected too
// ─────────────────────────────────────────────────────────────────

function rewriteManifest(text, baseUrl, proxyOrigin, knownOrigins, prefReferer) {
  const base = new URL(baseUrl);
  const encOrigins = (knownOrigins || []).map(o => `known_origins=${encodeURIComponent(o)}`).join('&');
  const encRef = prefReferer ? `preferred_referer=${encodeURIComponent(prefReferer)}` : '';
  const common = [encOrigins, encRef].filter(Boolean).join('&');
  const suffix = common ? `&${common}` : '';

  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return trimmed;
      if (trimmed.includes('/proxy?') || trimmed.includes('/proxy/')) return trimmed;

      let absoluteUrl;
      try { absoluteUrl = new URL(trimmed, base).href; } catch { return trimmed; }

      return `${proxyOrigin}/proxy?url=${encodeURIComponent(absoluteUrl)}${suffix}`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────
//  Per-kind response handlers
// ─────────────────────────────────────────────────────────────────

const SEGMENT_PASSTHROUGH = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'cache-control', 'etag', 'last-modified', 'content-disposition',
];

const STREAM_PASSTHROUGH = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'cache-control', 'icy-name', 'icy-genre', 'icy-url', 'icy-br',
  'icy-sr', 'icy-metaint', 'icy-description',
];

function sendManifest(req, res, url, text, knownOrigins, prefReferer, detectedAs) {
  const rewritten = rewriteManifest(text, url, proxyOriginFromReq(req), knownOrigins, prefReferer);
  manifestCache.set(`${url}|${prefReferer}`, rewritten);
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.set('Cache-Control', 'no-store');
  res.set('X-Proxy-Cache', 'MISS');
  res.set('X-Detected-As', detectedAs || 'hls-manifest');
  return res.send(rewritten);
}

async function sendSegment(req, res, url, upstream) {
  upstream.headers.forEach((value, key) => {
    if (SEGMENT_PASSTHROUGH.includes(key.toLowerCase())) res.set(key, value);
  });
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('X-Proxy-Cache', 'MISS');
  res.set('X-Detected-As', 'segment');

  const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
  if (upstream.ok && contentLength > 0 && contentLength <= SEGMENT_CACHE_MAX_BYTES) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    const cacheHeaders = {};
    SEGMENT_PASSTHROUGH.forEach(k => { const v = upstream.headers.get(k); if (v) cacheHeaders[k] = v; });
    segmentCache.set(url, { body: buf, headers: cacheHeaders });
    return res.status(upstream.status).send(buf);
  }

  // Large or unknown-size: pipe directly
  const nodeBody = toNodeStream(upstream.body);
  if (!nodeBody) return res.status(502).send('Could not stream upstream body.');
  res.status(upstream.status);
  nodeBody.pipe(res);
  nodeBody.on('error', () => res.end());
  req.on('close', () => { if (typeof nodeBody.destroy === 'function') nodeBody.destroy(); });
}

function sendStream(req, res, upstream) {
  upstream.headers.forEach((value, key) => {
    if (STREAM_PASSTHROUGH.includes(key.toLowerCase())) res.set(key, value);
  });
  if (!res.getHeader('content-type')) res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-store');
  res.set('X-Detected-As', 'live-stream');
  res.status(upstream.status);

  const nodeBody = toNodeStream(upstream.body);
  if (!nodeBody) return res.status(502).send('Could not stream upstream body.');
  nodeBody.pipe(res);
  nodeBody.on('error', () => res.end());
  req.on('close', () => { if (typeof nodeBody.destroy === 'function') nodeBody.destroy(); });
}

// ─────────────────────────────────────────────────────────────────
//  Express app
// ─────────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    activeRequests: activeCount,
    manifestCacheEntries: manifestCache.size,
    segmentCacheEntries: segmentCache.size,
  });
});

// ─────────────────────────────────────────────────────────────────
//  /proxy — unified auto-detecting route
//
//  Query params:
//    url=<encoded>           target URL  (or u=<base64>)
//    preferred_referer=...   Referer/Origin override
//    known_origins=...       passed down into rewritten manifests
//    force=manifest|segment|stream   skip auto-detection
// ─────────────────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = decodeUrl(req);
  if (!url || !isSafeHttpUrl(url)) {
    return res.status(400).send('Parâmetro ?url= (encoded) ou ?u= (base64) com http/https é obrigatório.');
  }

  const knownOrigins = decodeKnownOrigins(req, url);
  const prefReferer  = decodePreferredReferer(req, url);
  const forced       = req.query.force; // 'manifest' | 'segment' | 'stream' | undefined

  // ── Cache lookups (before any fetch) ────────────────────────────
  if (!forced || forced === 'manifest') {
    const hit = manifestCache.get(`${url}|${prefReferer}`);
    if (hit) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      res.set('X-Proxy-Cache', 'HIT');
      res.set('X-Detected-As', 'hls-manifest');
      return res.send(hit);
    }
  }

  if (!forced || forced === 'segment') {
    const hit = segmentCache.get(url);
    if (hit) {
      Object.entries(hit.headers).forEach(([k, v]) => { if (v) res.set(k, v); });
      res.set('X-Proxy-Cache', 'HIT');
      res.set('X-Detected-As', 'segment');
      return res.status(200).send(hit.body);
    }
  }

  // ── Build request headers ────────────────────────────────────────
  const headers = browserHeaders(prefReferer);
  if (req.headers.range)           headers.Range       = req.headers.range;
  if (req.headers['icy-metadata']) headers['Icy-MetaData'] = req.headers['icy-metadata'];

  try {
    const cookies = await getFlareCookies(url, prefReferer);
    if (cookies) headers.Cookie = cookies;

    const upstream = await fetchLimited(url, { method: 'GET', headers });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status} for ${url}`);
    }

    const contentType = upstream.headers.get('content-type') || '';

    // ── If forced, skip detection ───────────────────────────────────
    if (forced === 'manifest') {
      const text = await upstream.text();
      return sendManifest(req, res, url, text, knownOrigins, prefReferer, 'hls-manifest');
    }
    if (forced === 'stream') {
      return sendStream(req, res, upstream);
    }
    if (forced === 'segment') {
      return await sendSegment(req, res, url, upstream);
    }

    // ── Auto-detect ─────────────────────────────────────────────────
    const ext = getUrlExtension(url);
    const ambiguous = AMBIGUOUS_EXTENSIONS.has(ext) && !/mpegurl|m3u/i.test(contentType);

    if (ambiguous) {
      // Buffer the body (manifests are always tiny text; segments are usually binary)
      // We read as text first — if it turns out to be a manifest we use it directly,
      // otherwise we re-encode to a Buffer and send as segment.
      const text = await upstream.text();
      const peek = text.trimStart().slice(0, 64);
      const kind = detectContentKind(url, contentType, peek);

      if (kind === 'manifest') {
        return sendManifest(req, res, url, text, knownOrigins, prefReferer, 'hls-disguised-txt');
      }

      // Segment/stream — re-encode and send
      const buf = Buffer.from(text, 'utf8');
      upstream.headers.forEach((value, key) => {
        if (SEGMENT_PASSTHROUGH.includes(key.toLowerCase())) res.set(key, value);
      });
      res.set('Content-Type', contentType || 'application/octet-stream');
      res.set('X-Proxy-Cache', 'MISS');
      res.set('X-Detected-As', kind);
      if (buf.length <= SEGMENT_CACHE_MAX_BYTES) {
        const cacheHeaders = {};
        SEGMENT_PASSTHROUGH.forEach(k => { const v = upstream.headers.get(k); if (v) cacheHeaders[k] = v; });
        segmentCache.set(url, { body: buf, headers: cacheHeaders });
      }
      return res.status(upstream.status).send(buf);
    }

    // Non-ambiguous: detect from URL ext + content-type alone (no body buffering)
    const kind = detectContentKind(url, contentType, null);

    if (kind === 'manifest') {
      const text = await upstream.text();
      return sendManifest(req, res, url, text, knownOrigins, prefReferer, 'hls-manifest');
    }
    if (kind === 'stream') {
      return sendStream(req, res, upstream);
    }
    return await sendSegment(req, res, url, upstream);

  } catch (error) {
    return res.status(502).send(`Proxy error: ${error?.message || String(error)}`);
  }
});

// ─────────────────────────────────────────────────────────────────
//  Legacy aliases — kept for any existing links/configs
// ─────────────────────────────────────────────────────────────────
app.get('/proxy/manifest', (req, res) => {
  const qs = new URLSearchParams({ ...req.query, force: 'manifest' }).toString();
  res.redirect(307, `/proxy?${qs}`);
});
app.get('/proxy/segment', (req, res) => {
  const qs = new URLSearchParams({ ...req.query, force: 'segment' }).toString();
  res.redirect(307, `/proxy?${qs}`);
});
app.get('/proxy/stream', (req, res) => {
  const qs = new URLSearchParams({ ...req.query, force: 'stream' }).toString();
  res.redirect(307, `/proxy?${qs}`);
});

// ─────────────────────────────────────────────────────────────────
//  Server bootstrap
// ─────────────────────────────────────────────────────────────────

const server = app.listen(PORT, HOST, () => {
  console.log(`HLS public proxy listening on ${HOST}:${PORT}`);
});

server.keepAliveTimeout = FETCH_TIMEOUT_MS + 5000;
server.headersTimeout   = FETCH_TIMEOUT_MS + 6000;

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));