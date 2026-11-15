import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, watchConfig, type Config } from "./config.ts";

const EXAMPLE = new URL("../config/meet.yaml", import.meta.url).pathname;

describe("meet.yaml", () => {
  it("runs without a file: LiveKit next door, guests through the lobby, no recordings", () => {
    const { config, warnings } = parseConfig("");
    expect(config.livekit).toEqual({
      url: "http://livekit:7880",
      publicUrl: "ws://localhost:7880",
      apiKey: "meet",
      apiSecret: "MEET_LIVEKIT_SECRET",
      metricsUrl: null,
      mediaPorts: null,
    });
    expect(config.limits).toEqual({ meetings: 20, people: 50, video: "720p", bandwidth: null });
    expect(config.lobby).toEqual({ guests: true, waitMinutes: 15 });
    expect(config.recording).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("reads the example in config/", async () => {
    const { readFileSync } = await import("node:fs");
    const { config, warnings } = parseConfig(readFileSync(EXAMPLE, "utf8"));
    expect(config.organization).toBe("Acme Corp");
    expect(config.limits.bandwidth).toBe(400);
    expect(config.recording?.allowedFor).toEqual([
      { group: "leadership", keepDays: 90 },
      { group: "sales", keepDays: 30 },
    ]);
    expect(config.recording?.neverFor).toEqual(["people-team"]);
    expect(config.turn.map((t) => t.transport)).toEqual(["udp", "tcp", "tls"]);
    expect(warnings).toEqual([]);
  });

  it("reads lengths, bandwidth and groups as people write them", () => {
    const { config } = parseConfig(`
lobby: { wait: 2h }
limits: { bandwidth: 1 Gbit/s, video: 1080p }
groups:
  Sales: [Emily@Example.com, emily@example.com]
  board: { name: Board, members: [robert@example.com] }
`);
    expect(config.lobby.waitMinutes).toBe(120);
    expect(config.limits).toMatchObject({ bandwidth: 1000, video: "1080p" });
    expect(config.groups).toEqual({ sales: { name: "Sales", members: ["emily@example.com"] }, board: { name: "Board", members: ["robert@example.com"] } });
  });

  it("warns about a recording group no one in the file is in", () => {
    const { warnings } = parseConfig("recording: { allowed_for: [{ group: finance, keep_days: 7 }] }");
    expect(warnings).toEqual([expect.stringContaining("finance")]);
  });

  it.each([
    ["colour: blue", "unknown colour"],
    ["livekit: { url: ftp://x }", "livekit.url"],
    ["livekit: { public_url: https://rtc.example.com }", "livekit.public_url"],
    ["livekit: { api_secret: s3cr3t-value }", "never the secret itself"],
    ["limits: { meetings: 0 }", "limits.meetings"],
    ["limits: { video: 4k }", "limits.video"],
    ["limits: { bandwidth: fast }", "limits.bandwidth"],
    ["lobby: { guests: maybe }", "lobby.guests"],
    ["lobby: { wait: soon }", "lobby.wait"],
    ["groups: { sales: [not-an-email] }", "groups.sales.members[0]"],
    ["recording: { allowed_for: [{ group: sales }] }", "keep_days"],
    ["recording: { allowed_for: [], storage: recordings }", "absolute path"],
    ["recording: { allowed_for: [], announce: false }", "announce"],
    ["turn: [{ host: turn.example.com, port: 3478, transport: quic }]", "transport"],
    ["time_zone: Mars/Olympus", "time zone"],
    ["a: [", "not valid YAML"],
  ])("refuses %s, naming the field", (text, words) => {
    expect(() => parseConfig(text)).toThrow(words);
  });

  it("applies a changed file, and keeps the last good one when the new one has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-config-"));
    const path = join(dir, "meet.yaml");
    writeFileSync(path, "limits: { meetings: 5 }\n");
    const applied: Config[] = [];
    const w = watchConfig(path, (c) => applied.push(c), { everyMs: 60_000 });
    expect(applied.map((c) => c.limits.meetings)).toEqual([5]);
    expect(w.state.error).toBeNull();
    writeFileSync(path, "limits: { meetings: -1 }\n");
    utimesSync(path, new Date(), new Date(Date.now() + 2000));
    w.read();
    expect(applied).toHaveLength(1);
    expect(w.state.error).toContain("limits.meetings");
    writeFileSync(path, "limits: { meetings: 7 }\n");
    utimesSync(path, new Date(), new Date(Date.now() + 4000));
    w.read();
    expect(applied.map((c) => c.limits.meetings)).toEqual([5, 7]);
    expect(w.state.error).toBeNull();
    w.stop();
  });

  it("says when the file cannot be read", () => {
    const w = watchConfig("/nowhere/meet.yaml", () => {}, { everyMs: 60_000 });
    expect(w.state.error).toContain("Cannot read /nowhere/meet.yaml");
    w.stop();
  });
});
