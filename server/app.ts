import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atLeast, AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { readWebhook } from "./livekit.ts";
import { log } from "./log.ts";
import { MeetError, type Actor, type Meet, type ProblemCode } from "./meet.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  meet: Meet;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** For tests only: bearer tokens that act as these members, with their email. main.ts never sets it. */
  testTokens?: Record<string, Actor>;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(meet: Meet, version: string) {
  return renderMetrics(version, { ...meet.gauges(), fileError: !!meet.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (MEET_METRICS_PORT). */
export function createMetricsHandler(meet: Meet, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const body = new URL(req.url ?? "/", "http://localhost").pathname === "/metrics" ? metricsText(meet, version) : "not found\n";
    res.writeHead(body === "not found\n" ? 404 : 200, { "content-type": "text/plain; version=0.0.4" }).end(body);
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "limit-reached": "Limit reached",
  "guests-not-allowed": "Guests not allowed",
  "rate-limited": "Too many requests",
  "media-server-unavailable": "Media server unavailable",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  const tooLarge = () => new MeetError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw tooLarge();
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readBody(req, limit)).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MeetError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for routes anyone may call: the version, and a guest's way in. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
  raw: () => Promise<Buffer>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

const ANONYMOUS: Actor = { id: "anonymous", name: "Anonymous", role: "user", email: null };

export function createApp({ db, meet, version, auth, adminToken, testTokens = {}, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });

  /** The pages run nothing from elsewhere; they connect only to this server and to LiveKit's address in meet.yaml. */
  const headers = () => ({
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
    "content-security-policy":
      `default-src 'self'; connect-src 'self' ${[...(IDENTITY ? [IDENTITY] : []), ...meet.mediaOrigins()].join(" ")}; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'`.replace(
        "'self' ;",
        "'self';",
      ),
  });

  function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", extra: Record<string, string> = {}) {
    res.writeHead(status, { ...headers(), ...extra, "content-type": type, "content-length": Buffer.byteLength(body) });
    res.end(body);
  }
  const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json");
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, headers()).end();
  };
  /** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
  function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
    const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
    send(res, status, JSON.stringify(body), "application/problem+json");
  }
  async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
    const file = normalize(join(dir, relative));
    if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
    try {
      send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
      return true;
    } catch {
      return false;
    }
  }

  const ticketOf = (req: IncomingMessage) => {
    const t = req.headers["x-lobby-ticket"];
    if (typeof t !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) throw new MeetError(401, "invalid-token", "Send the lobby ticket in X-Lobby-Ticket.");
    return t;
  };

  /** A recording's file, with Range support so a browser can seek in it. */
  function streamFile(req: IncomingMessage, res: ServerResponse, file: { path: string; size: number; name: string }) {
    const base = {
      ...headers(),
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, file.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1;
      if (start > end || start >= file.size) {
        res.writeHead(416, { ...base, "content-range": `bytes */${file.size}` }).end();
        return;
      }
      res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${file.size}`, "content-length": end - start + 1 });
      createReadStream(file.path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...base, "content-length": file.size });
    createReadStream(file.path).pipe(res);
  }

  const P = "/api/v1";
  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "meet", version }) },
    { method: "GET", path: `${P}/products`, auth: "user", handle: () => ({ products }) },
    { method: "GET", path: `${P}/me`, auth: "user", handle: ({ who }) => meet.me(who) },

    // Meetings: their links, made by hand, by Calendar or by Chat.
    { method: "GET", path: `${P}/meetings`, auth: "user", handle: ({ who, url }) => meet.list(who, url.searchParams.get("day")) },
    {
      method: "POST",
      path: `${P}/meetings`,
      auth: "user",
      handle: async ({ who, res, body }) => {
        const r = meet.create(who, await body());
        json(res, r.created ? 201 : 200, r.meeting);
      },
    },
    { method: "GET", path: `${P}/meetings/:id`, auth: "user", handle: ({ who, params }) => meet.get(who, params[0]!) },
    { method: "PATCH", path: `${P}/meetings/:id`, auth: "user", handle: async ({ who, params, body }) => meet.update(who, params[0]!, await body()) },
    {
      method: "DELETE",
      path: `${P}/meetings/:id`,
      auth: "user",
      handle: async ({ who, params, res }) => (await meet.remove(who, params[0]!), noContent(res)),
    },
    { method: "POST", path: `${P}/meetings/:id/join`, auth: "user", handle: ({ who, params }) => meet.join(who, params[0]!) },
    { method: "GET", path: `${P}/meetings/:id/lobby`, auth: "user", handle: ({ who, params }) => meet.lobbyList(who, params[0]!) },
    { method: "POST", path: `${P}/meetings/:id/lobby/:entry/admit`, auth: "user", handle: ({ who, params }) => meet.admit(who, params[0]!, params[1]!) },
    { method: "POST", path: `${P}/meetings/:id/lobby/:entry/deny`, auth: "user", handle: ({ who, params }) => meet.deny(who, params[0]!, params[1]!) },
    {
      method: "POST",
      path: `${P}/meetings/:id/recording`,
      auth: "user",
      handle: async ({ who, params, res }) => json(res, 201, await meet.startRecording(who, params[0]!)),
    },
    { method: "DELETE", path: `${P}/meetings/:id/recording`, auth: "user", handle: ({ who, params }) => meet.stopRecording(who, params[0]!) },
    {
      method: "POST",
      path: `${P}/meetings/:id/stats`,
      auth: "user",
      handle: async ({ who, params, body, res }) => (meet.memberReport(who, params[0]!, await body()), noContent(res)),
    },

    // A guest's way in: the link is the key, the lobby ticket their place in the queue.
    { method: "GET", path: `${P}/join/:id`, auth: "none", handle: ({ params }) => meet.joinInfo(params[0]!) },
    {
      method: "POST",
      path: `${P}/join/:id/lobby`,
      auth: "none",
      limit: 4096,
      handle: async ({ params, body, res }) => json(res, 201, meet.knock(params[0]!, await body())),
    },
    { method: "GET", path: `${P}/lobby`, auth: "none", handle: ({ req }) => meet.lobbyStatus(ticketOf(req)) },
    { method: "DELETE", path: `${P}/lobby`, auth: "none", handle: ({ req, res }) => (meet.leaveLobby(ticketOf(req)), noContent(res)) },
    {
      method: "POST",
      path: `${P}/lobby/stats`,
      auth: "none",
      limit: 4096,
      handle: async ({ req, body, res }) => (meet.guestReport(ticketOf(req), await body()), noContent(res)),
    },

    // LiveKit tells of rooms, people and recordings as they change; the request is signed with the API secret.
    {
      method: "POST",
      path: `${P}/livekit/webhook`,
      auth: "none",
      handle: async ({ req, raw, res }) => {
        const body = (await raw()).toString("utf8");
        const { apiKey, apiSecret } = meet.webhookKeys();
        const event = readWebhook(body, req.headers.authorization, apiKey, apiSecret);
        if (!event) throw new MeetError(401, "invalid-token", "The webhook is not signed with LiveKit's API key and secret.");
        meet.webhook(event);
        noContent(res);
      },
    },

    // Recordings: listed for those who were in them, and for viewers.
    { method: "GET", path: `${P}/recordings`, auth: "user", handle: ({ who, url }) => meet.recordings(who, url.searchParams.get("q")) },
    { method: "GET", path: `${P}/recordings/:id`, auth: "user", handle: ({ who, params }) => meet.recording(who, params[0]!) },
    {
      method: "GET",
      path: `${P}/recordings/:id/file`,
      auth: "user",
      handle: ({ who, params, req, res }) => streamFile(req, res, meet.recordingFile(who, params[0]!)),
    },
    {
      method: "DELETE",
      path: `${P}/recordings/:id`,
      auth: "user",
      handle: ({ who, params, res }) => (meet.deleteRecording(who, params[0]!), noContent(res)),
    },

    // For IT.
    { method: "GET", path: `${P}/server`, auth: "viewer", handle: () => meet.server() },
    { method: "GET", path: `${P}/integrations`, auth: "viewer", handle: () => meet.integrations() },
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => meet.settings() },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return ANONYMOUS;
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "token:admin", name: "Admin token", role: "admin", email: null };
    for (const [token, actor] of Object.entries(testTokens)) {
      if (!tokenMatches(req.headers.authorization, token)) continue;
      if (!atLeast(actor.role, access)) throw new MeetError(403, "forbidden", `This needs the ${access} role or higher.`);
      return actor;
    }
    const p = auth.authorize(req, access);
    return p.kind === "session"
      ? { id: p.user.id, name: p.user.name, role: p.role, email: p.user.email.toLowerCase() }
      : { id: `token:${p.tokenId}`, name: p.name, role: p.role, email: null };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      // Ready while the database answers; LiveKit being away shows on the Server page, so the pages stay up to say so.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(meet, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...headers(), location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const limit = r.limit ?? 256 * 1024;
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, limit), raw: () => readBody(req, limit) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof MeetError)) throw err;
        problem(res, err.status, err.code, err.message);
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths, meeting links among them, fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }
    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Only the route is logged: a meeting's link is its key, and lobby tickets travel in a header.
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, route: routeName, status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
