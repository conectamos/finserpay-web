import { createServer, request as httpRequest } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PRIVATE_HOST = "firma-portal-browser.railway.internal:3010";
const MAX_CONNECTIONS = 3;
const ACQUIRE_TIMEOUT_MS = 10_000;
const BROWSER_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH"];

export class FirmaSeguroBrowserWorkerError extends Error {
  constructor(code) { super(code); this.name = "FirmaSeguroBrowserWorkerError"; this.code = code; }
}

function singleHeader(request, name) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : undefined;
}
function hasHeader(request, name) {
  return request.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === name);
}
function digest(value) { return createHash("sha256").update(value).digest(); }
function handshake(request, tokenDigest) {
  if (request.rawHeaders.length > 64 || request.method !== "GET" || request.url !== "/connect"
    || singleHeader(request, "host") !== PRIVATE_HOST
    || hasHeader(request, "origin") || hasHeader(request, "cookie")) return null;
  const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(singleHeader(request, "authorization") || "");
  if (!bearer || !timingSafeEqual(digest(bearer[1]), tokenDigest)) return null;
  const key = singleHeader(request, "sec-websocket-key");
  if (singleHeader(request, "upgrade")?.toLowerCase() !== "websocket"
    || !singleHeader(request, "connection")?.split(",").some(value => value.trim().toLowerCase() === "upgrade")
    || singleHeader(request, "sec-websocket-version") !== "13"
    || !/^[A-Za-z0-9+/]{22}==$/.test(key || "") || Buffer.from(key, "base64").length !== 16) return null;
  // No Authorization, Cookie, Origin, x-playwright-* or client-selected routing headers reach Playwright.
  return { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key };
}
function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}
function pinnedEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { /* Never expose an endpoint or parser message. */ }
  if (!endpoint || endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1"
    || !/^[1-9]\d*$/.test(endpoint.port) || Number(endpoint.port) > 65535
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^\/[A-Za-z0-9_-]{16,256}$/.test(endpoint.pathname))
    throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_ENDPOINT_INVALID");
  return endpoint;
}

/** Imports do not start a server. Dependencies are injectable only for local fixture tests. */
export async function startFirmaSeguroBrowserWorker({
  env = process.env, runtime = process,
  readVersion = () => require("playwright/package.json").version,
  loadPlaywright = () => import("playwright"), createHTTPServer = createServer, request = httpRequest,
  report = event => console.info(JSON.stringify(event)), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (runtime.platform !== "linux") throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_LINUX_REQUIRED");
  let uid;
  try { uid = runtime.getuid?.(); } catch { /* Stable error below. */ }
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_NON_ROOT_REQUIRED");
  const token = env.FIRMASEGURO_BROWSER_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_TOKEN_INVALID");
  if (env.DEBUG || env.PWDEBUG) throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_DEBUG_FORBIDDEN");
  let version;
  try { version = readVersion(); } catch { /* Do not expose package paths. */ }
  if (version !== "1.65.0") throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_PACKAGE_UNAVAILABLE");
  const tokenDigest = digest(token);
  let browserServer, launchPromise, front, cancelListen, closing = false, ready = false, closePromise;
  const connections = new Set(), sockets = new Set();

  function bounded(work, milliseconds, code) {
    return new Promise((fulfill, reject) => {
      const timer = setTimer(() => reject(new FirmaSeguroBrowserWorkerError(code)), milliseconds);
      Promise.resolve().then(work).then(fulfill, reject).finally(() => clearTimer(timer));
    });
  }
  // The worker is the container entrypoint. Exit after the bounded cleanup even
  // if a launch has not yet returned a BrowserServer handle that can be killed.
  const signal = () => { void close().finally(() => runtime.exit?.(0)); };
  const unexpectedClose = () => {
    if (closing) return;
    runtime.exitCode = 1;
    void close().finally(() => runtime.exit?.(1));
  };
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    ready = false;
    runtime.removeListener("SIGTERM", signal);
    closePromise = (async () => {
      cancelListen?.();
      for (const connection of [...connections]) connection.close();
      for (const socket of sockets) socket.destroy();
      const closeFront = new Promise(fulfill => {
        if (!front) return fulfill();
        try { front.close(() => fulfill()); } catch { fulfill(); }
      });
      try {
        await bounded(() => Promise.all([closeFront, (async () => {
          if (!browserServer && launchPromise) {
            try { browserServer = await launchPromise; } catch { return; }
          }
          await browserServer?.close();
        })()]), 5_000, "BROWSER_WORKER_CLOSE_TIMEOUT");
      } catch {
        try { await bounded(() => browserServer?.kill(), 1_000, "BROWSER_WORKER_KILL_TIMEOUT"); }
        catch { try { browserServer?.process()?.kill("SIGKILL"); } catch { /* No raw process errors. */ } }
      }
    })();
    return closePromise;
  }

  runtime.once("SIGTERM", signal);
  try {
    const { chromium } = await loadPlaywright();
    if (closing) throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED");
    const browserEnv = Object.fromEntries(BROWSER_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
    launchPromise = chromium.launchServer({ host: "127.0.0.1", port: 0, headless: true,
      chromiumSandbox: true, env: browserEnv, timeout: 30_000,
      handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false });
    browserServer = await launchPromise;
    if (closing) {
      await close();
      throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED");
    }
    const endpoint = pinnedEndpoint(browserServer.wsEndpoint());
    browserServer.once("close", unexpectedClose);
    // A connected client's close disconnects it; BrowserServer.close is reserved for worker shutdown.
    async function verifyRenderer(endpointUrl, options, code) {
      await bounded(async () => {
        let browser, context;
        try {
          browser = await chromium.connect(endpointUrl, options);
          context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
          await context.route("**/*", route => route.abort("blockedbyclient"));
          const page = await context.newPage();
          page.setDefaultTimeout(ACQUIRE_TIMEOUT_MS);
          await page.setContent('<!doctype html><p id="worker-ready">ready</p>', { waitUntil: "load", timeout: ACQUIRE_TIMEOUT_MS });
          if (await page.textContent("#worker-ready") !== "ready") throw new Error("Renderer check failed");
        } finally {
          try { await context?.close(); } finally { await browser?.close(); }
        }
      }, ACQUIRE_TIMEOUT_MS, code).catch(() => { throw new FirmaSeguroBrowserWorkerError(code); });
    }
    await verifyRenderer(endpoint.href, { timeout: ACQUIRE_TIMEOUT_MS }, "BROWSER_WORKER_RENDERER_FAILED");
    if (closing) throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED");

    front = createHTTPServer({ maxHeaderSize: 8192 }, (req, res) => {
      const health = req.method === "GET" && req.url === "/health";
      if (!closing && ready && health) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"ok":true}');
      } else {
        res.writeHead(closing || health ? 503 : 404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"ok":false}');
      }
    });
    front.headersTimeout = ACQUIRE_TIMEOUT_MS;
    front.requestTimeout = ACQUIRE_TIMEOUT_MS;
    front.keepAliveTimeout = 5_000;
    // Keep every raw header for duplicate/Origin/Cookie checks. Node's count limit
    // can truncate parsed headers; enforce the count ourselves above (bytes remain capped at 8KB).
    front.maxHeadersCount = 0;
    front.on("connection", socket => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
    });
    front.on("clientError", (_error, socket) => rejectUpgrade(socket, 400));
    front.on("upgrade", (req, client, head) => {
      if (closing) { rejectUpgrade(client, 503); return; }
      const headers = handshake(req, tokenDigest);
      if (!headers) { rejectUpgrade(client, 403); return; }
      if (connections.size >= MAX_CONNECTIONS) { rejectUpgrade(client, 503); return; }
      let ended = false, upstream, backend, timer;
      const connection = { close: () => finish() };
      // Pending handshakes reserve a slot too; every terminal event shares this idempotent release.
      connections.add(connection);
      function finish(status) {
        if (ended) return;
        ended = true;
        clearTimer(timer);
        connections.delete(connection);
        upstream?.destroy();
        backend?.destroy();
        if (status) rejectUpgrade(client, status); else client.destroy();
      }
      client.pause();
      client.once("close", () => finish());
      client.once("end", () => finish());
      client.once("error", () => finish());
      timer = setTimer(() => finish(504), ACQUIRE_TIMEOUT_MS);
      try {
        upstream = request({ hostname: "127.0.0.1", port: Number(endpoint.port), path: endpoint.pathname,
          method: "GET", agent: false, headers });
        upstream.once("error", () => finish(502));
        upstream.once("response", response => { response.destroy(); finish(502); });
        upstream.once("upgrade", (response, socket, backendHead) => {
          if (ended || closing) { socket.destroy(); finish(); return; }
          backend = socket;
          const expectedAccept = createHash("sha1").update(headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== "websocket"
            || response.headers["sec-websocket-accept"] !== expectedAccept) { finish(502); return; }
          clearTimer(timer);
          // Absolute session deadline; traffic cannot keep three abandoned slots occupied forever.
          timer = setTimer(() => finish(), 300_000);
          backend.once("error", () => finish());
          backend.once("end", () => finish());
          backend.once("close", () => finish());
          client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expectedAccept}\r\n\r\n`);
          if (backendHead.length) client.write(backendHead);
          if (head.length) backend.write(head);
          client.pipe(backend);
          backend.pipe(client);
          client.resume();
          backend.resume();
        });
        upstream.end();
      } catch { finish(502); }
      // launchServer's default (non-shared) Playwright connection owns its contexts.
      // Destroying both transport sockets invokes Playwright's per-connection context cleanup.
    });
    await new Promise((fulfill, reject) => {
      const fail = error => { front.removeListener("error", fail); cancelListen = undefined; reject(error); };
      cancelListen = () => fail(new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED"));
      front.once("error", fail);
      front.listen(3010, "::", () => { front.removeListener("error", fail); cancelListen = undefined; fulfill(); });
    });
    if (closing) throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED");
    front.on("error", unexpectedClose);
    const port = front.address()?.port;
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
      throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_GATEWAY_FAILED");
    // Exercise the real Playwright protocol through our authenticated proxy before readiness.
    await verifyRenderer(`ws://127.0.0.1:${port}/connect`, { timeout: ACQUIRE_TIMEOUT_MS,
      headers: { Host: PRIVATE_HOST, Authorization: `Bearer ${token}` } }, "BROWSER_WORKER_GATEWAY_FAILED");
    if (closing) throw new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED");
    ready = true;
    report({ event: "firmaseguro_browser_worker_ready", sandbox: true, uid, playwrightVersion: version, renderer: true, gateway: true });
    return { close };
  } catch (error) {
    await close();
    throw error instanceof FirmaSeguroBrowserWorkerError ? error : new FirmaSeguroBrowserWorkerError("BROWSER_WORKER_START_FAILED");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startFirmaSeguroBrowserWorker().catch(error => {
    console.error(JSON.stringify({ event: "firmaseguro_browser_worker_failed",
      code: error instanceof FirmaSeguroBrowserWorkerError ? error.code : "BROWSER_WORKER_START_FAILED" }));
    process.exitCode = 1;
  });
}
