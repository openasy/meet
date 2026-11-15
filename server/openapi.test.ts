import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import type { Actor } from "./meet.ts";
import { ADMIN_TOKEN, ALI, CALENDAR, EMILY, HAKAN, ROBERT, SELIN, startApp, tokenOf, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "meet-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (type === "video/mp4") return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const as = (who: Actor | "admin", b?: unknown) => ({
  headers: { authorization: `Bearer ${who === "admin" ? ADMIN_TOKEN : tokenOf(who)}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const anon = (b?: unknown, headers: Record<string, string> = {}) => ({
  headers: { "content-type": "application/json", ...headers },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/me"]) {
      await call("GET", p, as(EMILY));
      await call("GET", p, {});
    }
    await call("GET", "/api/v1/me", as("admin"));
    await call("GET", "/api/v1/me", as(ALI));
    await call("GET", "/api/v1/me", as(ROBERT));
    for (const p of ["/api/v1/server", "/api/v1/integrations", "/api/v1/settings"]) {
      await call("GET", p, as(HAKAN));
      await call("GET", p, as(EMILY));
    }
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("meetings", async () => {
    const made = await call("POST", "/api/v1/meetings", as(EMILY, { title: "Demo: Northwind", allowRecording: true, invited: ["dana@northwind.example"] }));
    ids.meeting = made.body.id;
    await call("POST", "/api/v1/meetings", as(ALI, { allowRecording: true }));
    await call("POST", "/api/v1/meetings", as(EMILY, { title: "" }));
    await call("POST", "/api/v1/meetings", as(EMILY, "{"));
    await call("POST", "/api/v1/meetings", as("admin", { title: "No one's" }));
    const cal = {
      source: "calendar",
      reference: "event-1@example.com",
      title: "Product review",
      organizer: { email: "robert@example.com" },
      startsAt: "2026-11-05T12:00:00Z",
      endsAt: "2026-11-05T13:00:00Z",
      invited: ["emily@example.com", "ali@example.com"],
    };
    ids.calendar = (await call("POST", "/api/v1/meetings", as(CALENDAR, cal))).body.id;
    await call("POST", "/api/v1/meetings", as(CALENDAR, cal));
    await call("POST", "/api/v1/meetings", as(EMILY, { organizer: { email: "robert@example.com" } }));
    await call("GET", "/api/v1/meetings", as(EMILY));
    await call("GET", "/api/v1/meetings", as(HAKAN), "/api/v1/meetings?day=2026-11-05");
    await call("GET", "/api/v1/meetings", as(EMILY), "/api/v1/meetings?day=5.11.2026");
    await call("GET", "/api/v1/meetings/{id}", as(EMILY), `/api/v1/meetings/${ids.meeting}`);
    await call("GET", "/api/v1/meetings/{id}", as(ALI), `/api/v1/meetings/${ids.meeting}`);
    await call(
      "PATCH",
      "/api/v1/meetings/{id}",
      as(CALENDAR, { startsAt: "2026-11-05T13:00:00Z", endsAt: "2026-11-05T14:00:00Z" }),
      `/api/v1/meetings/${ids.calendar}`,
    );
    await call("PATCH", "/api/v1/meetings/{id}", as(EMILY, { title: 5 }), `/api/v1/meetings/${ids.meeting}`);
    await call("PATCH", "/api/v1/meetings/{id}", as(EMILY, "{"), `/api/v1/meetings/${ids.meeting}`);
    await call("PATCH", "/api/v1/meetings/{id}", as(EMILY, {}), "/api/v1/meetings/no-such-one");
    await call("PATCH", "/api/v1/meetings/{id}", as(ALI, { title: "Mine now" }), `/api/v1/meetings/${ids.calendar}`);
    const spare = (await call("POST", "/api/v1/meetings", as(EMILY, { title: "Spare" }))).body.id;
    await call("DELETE", "/api/v1/meetings/{id}", as(EMILY), `/api/v1/meetings/${spare}`);
    await call("DELETE", "/api/v1/meetings/{id}", as(EMILY), `/api/v1/meetings/${spare}`);
  });

  it("joining, the lobby and how people connect", async () => {
    const m = ids.meeting!;
    await call("POST", "/api/v1/meetings/{id}/join", as("admin"), `/api/v1/meetings/${m}/join`);
    await call("POST", "/api/v1/meetings/{id}/join", as(EMILY), "/api/v1/meetings/nope/join");
    const j = await call("POST", "/api/v1/meetings/{id}/join", as(EMILY), `/api/v1/meetings/${m}/join`);
    app.lk.join(m, j.body.identity, "Emily Clark");
    await app.meet.reconcile();
    await call("GET", "/api/v1/join/{id}", {}, `/api/v1/join/${m}`);
    await call("GET", "/api/v1/join/{id}", {}, "/api/v1/join/nope");
    const knock = await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "Mina Seo", email: "mina.seo@northwind.example" }), `/api/v1/join/${m}/lobby`);
    await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "" }), `/api/v1/join/${m}/lobby`);
    await call("POST", "/api/v1/join/{id}/lobby", anon("{"), `/api/v1/join/${m}/lobby`);
    await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "x".repeat(5000) }), `/api/v1/join/${m}/lobby`);
    await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "Nobody" }), "/api/v1/join/nope/lobby");
    const ticket = { "x-lobby-ticket": knock.body.ticket };
    await call("GET", "/api/v1/lobby", anon(undefined, ticket));
    await call("GET", "/api/v1/lobby", anon(undefined, { "x-lobby-ticket": "a".repeat(32) }));
    await call("GET", "/api/v1/lobby", anon());
    await call("POST", "/api/v1/lobby/stats", anon({ path: "udp" }, ticket));
    await call("GET", "/api/v1/meetings/{id}/lobby", as(EMILY), `/api/v1/meetings/${m}/lobby`);
    await call("GET", "/api/v1/meetings/{id}/lobby", as(ALI), `/api/v1/meetings/${m}/lobby`);
    await call("GET", "/api/v1/meetings/{id}/lobby", as(EMILY), "/api/v1/meetings/nope/lobby");
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/admit", as(EMILY), `/api/v1/meetings/${m}/lobby/${knock.body.id}/admit`);
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/admit", as(EMILY), `/api/v1/meetings/${m}/lobby/${knock.body.id}/admit`);
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/admit", as(EMILY), `/api/v1/meetings/${m}/lobby/nobody/admit`);
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/admit", as(ALI), `/api/v1/meetings/${m}/lobby/${knock.body.id}/admit`);
    const second = await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "Leo Park" }), `/api/v1/join/${m}/lobby`);
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/deny", as(EMILY), `/api/v1/meetings/${m}/lobby/${second.body.id}/deny`);
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/deny", as(EMILY), `/api/v1/meetings/${m}/lobby/${second.body.id}/deny`);
    await call("POST", "/api/v1/meetings/{id}/lobby/{entry}/deny", as(EMILY), `/api/v1/meetings/${m}/lobby/nobody/deny`);
    const status = await call("GET", "/api/v1/lobby", anon(undefined, ticket));
    expect(status.body.join).not.toBeNull();
    await call(
      "POST",
      "/api/v1/lobby/stats",
      anon({ path: "turn-tls", rttMs: 284, lossPercent: 3.8, sendKbps: 30, receiveKbps: 900, sending: "Audio only", browser: "Safari on iPhone" }, ticket),
    );
    await call("POST", "/api/v1/lobby/stats", anon({ path: "carrier pigeon" }, ticket));
    await call("POST", "/api/v1/lobby/stats", anon("{", ticket));
    await call("POST", "/api/v1/lobby/stats", anon({ browser: "x".repeat(5000) }, ticket));
    await call(
      "POST",
      "/api/v1/meetings/{id}/stats",
      as(EMILY, { path: "udp", rttMs: 4, lossPercent: 0, sendKbps: 1500, receiveKbps: 2400, sending: "720p", browser: "Firefox 132" }),
      `/api/v1/meetings/${m}/stats`,
    );
    await call("POST", "/api/v1/meetings/{id}/stats", as(EMILY, { rttMs: -1 }), `/api/v1/meetings/${m}/stats`);
    await call("POST", "/api/v1/meetings/{id}/stats", as(EMILY, "{"), `/api/v1/meetings/${m}/stats`);
    await call("POST", "/api/v1/meetings/{id}/stats", as(EMILY, {}), "/api/v1/meetings/nope/stats");
    await call("POST", "/api/v1/meetings/{id}/stats", as("admin", {}), `/api/v1/meetings/${m}/stats`);
    await call("GET", "/api/v1/server", as(HAKAN));
    const third = await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "Sam" }), `/api/v1/join/${m}/lobby`);
    await call("DELETE", "/api/v1/lobby", anon(undefined, { "x-lobby-ticket": third.body.ticket }));
    await call("DELETE", "/api/v1/lobby", anon(undefined, { "x-lobby-ticket": "b".repeat(32) }));
    await call("DELETE", "/api/v1/lobby", anon());
    // Too many waiting: the lobby has room for twenty.
    for (let i = 0; i < 20; i++) await fetch(`${base}/api/v1/join/${m}/lobby`, { method: "POST", body: JSON.stringify({ name: `Guest ${i}` }) });
    await call("POST", "/api/v1/join/{id}/lobby", anon({ name: "One too many" }), `/api/v1/join/${m}/lobby`);
    // A meeting with no live call when the server limit is reached: three are allowed at once.
    for (const t of ["One", "Two"]) {
      const x = (await call("POST", "/api/v1/meetings", as(ROBERT, { title: t }))).body.id;
      await call("POST", "/api/v1/meetings/{id}/join", as(ROBERT), `/api/v1/meetings/${x}/join`);
    }
    const fourth = (await call("POST", "/api/v1/meetings", as(ROBERT, { title: "Four" }))).body.id;
    await call("POST", "/api/v1/meetings/{id}/join", as(ROBERT), `/api/v1/meetings/${fourth}/join`);
    app.lk.state.down = 503;
    await call("POST", "/api/v1/meetings/{id}/join", as(EMILY), `/api/v1/meetings/${m}/join`);
    app.lk.state.down = 0;
  });

  it("guests when the file allows none", async () => {
    const off = await startApp({ version, settings: (await import("./test-app.ts")).SETTINGS.replace("guests: true", "guests: false") });
    const m = (await off.as(EMILY)("POST", "/api/v1/meetings", { title: "Closed" })).body.id;
    const res = await fetch(`${off.base}/api/v1/join/${m}/lobby`, { method: "POST", body: JSON.stringify({ name: "Mina" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    const validate = ajv.getSchema("openapi#/components/responses/Problem/content/application~1problem+json/schema")!;
    expect(validate(body)).toBe(true);
    await off.close();
  });

  it("recordings", async () => {
    const m = ids.meeting!;
    await call("POST", "/api/v1/meetings/{id}/recording", as(ALI), `/api/v1/meetings/${m}/recording`);
    await call("POST", "/api/v1/meetings/{id}/recording", as(EMILY), "/api/v1/meetings/nope/recording");
    await call("DELETE", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    const rec = await call("POST", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    await call("POST", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    await call("DELETE", "/api/v1/meetings/{id}/recording", as(ALI), `/api/v1/meetings/${m}/recording`);
    await call("DELETE", "/api/v1/recordings/{id}", as(EMILY), `/api/v1/recordings/${rec.body.id}`);
    await call("GET", "/api/v1/recordings/{id}/file", as(EMILY), `/api/v1/recordings/${rec.body.id}/file`);
    await call("DELETE", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    await call("DELETE", "/api/v1/meetings/{id}/recording", as(EMILY), "/api/v1/meetings/nope/recording");
    const egress = [...app.lk.state.egress.values()].at(-1)!;
    writeFileSync(egress.filepath, Buffer.alloc(2048, 7));
    const hook = app.lk.webhook("egress_ended", { egress_info: app.lk.finishEgress(egress.egressId) });
    const r = await fetch(`${base}/api/v1/livekit/webhook`, {
      method: "POST",
      headers: { authorization: hook.authorization, "content-type": "application/webhook+json" },
      body: hook.body,
    });
    expect(r.status).toBe(204);
    await call("POST", "/api/v1/livekit/webhook", {
      method: "POST",
      headers: { authorization: hook.authorization, "content-type": "application/webhook+json" },
      body: hook.body,
    });
    await call("POST", "/api/v1/livekit/webhook", { headers: { authorization: "Bearer forged", "content-type": "application/webhook+json" }, body: hook.body });
    await call("POST", "/api/v1/livekit/webhook", { headers: { "content-type": "application/webhook+json" }, body: "x".repeat(300 * 1024) });
    await call("GET", "/api/v1/recordings", as(EMILY));
    await call("GET", "/api/v1/recordings", as(HAKAN), "/api/v1/recordings?q=northwind");
    await call("GET", "/api/v1/recordings/{id}", as(EMILY), `/api/v1/recordings/${rec.body.id}`);
    await call("GET", "/api/v1/recordings/{id}", as(ALI), `/api/v1/recordings/${rec.body.id}`);
    await call("GET", "/api/v1/recordings/{id}/file", as(EMILY), `/api/v1/recordings/${rec.body.id}/file`);
    await call("GET", "/api/v1/recordings/{id}/file", { headers: { ...as(EMILY).headers, range: "bytes=0-99" } }, `/api/v1/recordings/${rec.body.id}/file`);
    await call("GET", "/api/v1/recordings/{id}/file", as(ALI), `/api/v1/recordings/${rec.body.id}/file`);
    await call("DELETE", "/api/v1/recordings/{id}", as(HAKAN), `/api/v1/recordings/${rec.body.id}`);
    await call("DELETE", "/api/v1/recordings/{id}", as(SELIN), `/api/v1/recordings/${rec.body.id}`);
    await call("DELETE", "/api/v1/recordings/{id}", as(SELIN), `/api/v1/recordings/${rec.body.id}`);
    // Egress cannot be reached.
    app.lk.state.egressError = "no egress workers";
    await call("POST", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    app.lk.state.egressError = "";
    const again = await call("POST", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    app.lk.state.down = 503;
    await call("DELETE", "/api/v1/meetings/{id}/recording", as(EMILY), `/api/v1/meetings/${m}/recording`);
    await call("DELETE", "/api/v1/meetings/{id}", as(EMILY), `/api/v1/meetings/${m}`);
    app.lk.state.down = 0;
    await call("DELETE", "/api/v1/meetings/{id}/recording", as(SELIN), `/api/v1/meetings/${m}/recording`);
    expect(again.body.state).toBe("recording");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
