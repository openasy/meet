// Starts the app on a random port for tests, against the LiveKit fake, with a token for each member so a test calls the
// API as that person, and a clock the test moves by hand.
import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { API_KEY, API_SECRET, startFakeLiveKit } from "./fake-livekit.ts";
import { createMeet, type Actor } from "./meet.ts";
import type { TurnCheck } from "./turn.ts";

export const ADMIN_TOKEN = "test-admin-token";

/**
 * Members of the test install. Emily is in Sales, which may record for 30 days; Robert in Leadership (90 days); Pat is
 * in Sales and the People team, which never records; Ali is in no group. Hakan is IT with the viewer role; Selin an admin.
 */
export const EMILY: Actor = { id: "user-emily", name: "Emily Clark", role: "user", email: "emily@example.com" };
export const ROBERT: Actor = { id: "user-robert", name: "Robert Fox", role: "user", email: "robert@example.com" };
export const PAT: Actor = { id: "user-pat", name: "Pat Lee", role: "user", email: "pat@example.com" };
export const ALI: Actor = { id: "user-ali", name: "Ali Demir", role: "user", email: "ali@example.com" };
export const HAKAN: Actor = { id: "user-hakan", name: "Hakan Yıldız", role: "viewer", email: "hakan@example.com" };
export const CALENDAR: Actor = { id: "user-calendar", name: "Calendar", role: "editor", email: "calendar@example.com" };
export const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "admin", email: "selin@example.com" };
export const MEMBERS = [EMILY, ROBERT, PAT, ALI, HAKAN, CALENDAR, SELIN];
export const tokenOf = (a: Actor) => `test-token-${a.id}`;

/** The settings file the tests start with; LIVEKIT_URL and STORAGE are replaced with the fake's address and a temp folder. */
export const SETTINGS = `
time_zone: Europe/Istanbul
organization: Acme Corp
livekit:
  url: LIVEKIT_URL
  public_url: wss://rtc.example.com
  api_key: ${API_KEY}
  api_secret: MEET_LIVEKIT_SECRET
  media_ports: UDP 50000 to 60000
limits: { meetings: 3, people: 50, video: 720p, bandwidth: 400 Mbit/s }
lobby: { guests: true, wait: 10m }
groups:
  sales: { name: Sales, members: [emily@example.com, pat@example.com] }
  leadership: { name: Leadership, members: [robert@example.com] }
  people-team: { name: People team, members: [pat@example.com] }
recording:
  allowed_for:
    - { group: leadership, keep_days: 90 }
    - { group: sales, keep_days: 30 }
  never_for: [people-team]
  storage: STORAGE
  announce: true
turn:
  - { host: turn.example.com, port: 3478, transport: udp }
  - { host: turn.example.com, port: 443, transport: tls }
`;

/** A clock the test moves by hand: Thursday 5 November 2026, 14:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-05T11:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string } = {}) {
  const lk = await startFakeLiveKit();
  const db = openDb(":memory:");
  const storage = mkdtempSync(join(tmpdir(), "meet-recordings-"));
  const { settings = SETTINGS, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "meet", productName: "OpenAsy Meet", origin: base, users: true });
  for (const m of MEMBERS)
    db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
      m.id,
      m.email,
      m.name,
      m.role,
      new Date().toISOString(),
    );
  const turn = { answer: true };
  const meet = createMeet(db, {
    publicUrl: "https://meet.example.com",
    env: { MEET_LIVEKIT_SECRET: API_SECRET },
    clock,
    turnCheck: async (host, port, transport): Promise<TurnCheck> => ({
      host,
      port,
      transport,
      ok: turn.answer,
      ms: turn.answer ? 12 : null,
      error: turn.answer ? null : "No answer within 4 s.",
      at: new Date(clock()).toISOString(),
    }),
  });
  const text = settings.replaceAll("LIVEKIT_URL", lk.url).replaceAll("STORAGE", storage);
  meet.setConfig(parseConfig(text).config, text);
  const testTokens = Object.fromEntries(MEMBERS.map((m) => [tokenOf(m), m]));
  handler = createApp({ db, meet, auth, adminToken: ADMIN_TOKEN, testTokens, version, ...rest });

  /** Calls the API as a member (or the admin token, or no one), with a JSON body and extra headers. */
  const as =
    (who: Actor | "admin" | null, headers: Record<string, string> = {}) =>
    async (method: string, path: string, body?: unknown) => {
      const h: Record<string, string> = { "content-type": "application/json", ...headers };
      if (who) h.authorization = `Bearer ${who === "admin" ? ADMIN_TOKEN : tokenOf(who)}`;
      const res = await fetch(base + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const type = res.headers.get("content-type") ?? "";
      const data = type.includes("json") ? await res.json() : type.startsWith("text/") ? await res.text() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: data as any, headers: res.headers };
    };
  /** Sends a webhook from the fake, signed as LiveKit would. */
  const hook = async (w: { body: string; authorization: string }) =>
    fetch(`${base}/api/v1/livekit/webhook`, {
      method: "POST",
      headers: { "content-type": "application/webhook+json", authorization: w.authorization },
      body: w.body,
    });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await lk.stop();
  };
  return { db, meet, auth, base, as, hook, lk, clock, storage, turn, close };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
