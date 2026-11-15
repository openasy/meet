import { describe, expect, it } from "vitest";
import { accessToken, readEgress, readParticipant, readProcessMetrics, readRoom, readWebhook, signJwt, signWebhook, verifyJwt } from "./livekit.ts";

const decode = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8"));

describe("LiveKit's tokens", () => {
  it("signs and checks HS256 tokens, and refuses others", () => {
    const t = signJwt({ iss: "k", exp: Math.floor(Date.now() / 1000) + 60 }, "s");
    expect(verifyJwt(t, "s")).toMatchObject({ iss: "k" });
    expect(verifyJwt(t, "other")).toBeNull();
    expect(verifyJwt(t.replace(/\.[^.]+\./, `.${Buffer.from('{"iss":"k"}').toString("base64url")}.`), "s")).toBeNull();
    expect(verifyJwt(signJwt({ exp: 1 }, "s"), "s")).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
    expect(verifyJwt(none, "s")).toBeNull();
    expect(verifyJwt("not a token", "s")).toBeNull();
  });

  it("puts the identity, name and grant where LiveKit reads them", () => {
    const now = Date.parse("2026-11-05T11:00:00Z");
    const t = accessToken({
      apiKey: "meet",
      apiSecret: "secret",
      identity: "u:1",
      name: "Emily Clark",
      metadata: '{"kind":"member"}',
      video: { roomJoin: true, room: "abc-def-ghi", canPublish: true },
      ttlSeconds: 900,
      now,
    });
    expect(decode(t)).toMatchObject({
      iss: "meet",
      sub: "u:1",
      name: "Emily Clark",
      metadata: '{"kind":"member"}',
      video: { roomJoin: true, room: "abc-def-ghi", canPublish: true },
      nbf: now / 1000,
      exp: now / 1000 + 900,
    });
    expect(verifyJwt(t, "secret", now)).not.toBeNull();
  });
});

describe("LiveKit's answers", () => {
  it("reads both of protobuf's JSON spellings and 64-bit numbers as strings", () => {
    expect(readRoom({ sid: "RM_1", name: "x", num_participants: 3, creation_time: "1762340400", active_recording: true })).toEqual({
      sid: "RM_1",
      name: "x",
      participants: 3,
      createdAt: 1762340400000,
      recording: true,
    });
    expect(readRoom({ sid: "RM_1", name: "x", numParticipants: 2, creationTime: "1" }).participants).toBe(2);
    expect(readParticipant({ identity: "g:1", name: "Mina", joinedAt: "10", state: 2 })).toMatchObject({ identity: "g:1", joinedAt: 10_000, state: "ACTIVE" });
    expect(
      readEgress({
        egressId: "EG_1",
        roomName: "x",
        status: "EGRESS_COMPLETE",
        startedAt: "1000000000",
        endedAt: "61000000000",
        fileResults: [{ filename: "/recordings/a.mp4", size: "2048", duration: "60000000000" }],
      }),
    ).toEqual({
      egressId: "EG_1",
      roomName: "x",
      state: "complete",
      startedAt: 1000,
      endedAt: 61000,
      error: null,
      file: { filename: "/recordings/a.mp4", size: 2048, durationMs: 60000 },
    });
    expect(readEgress({ egress_id: "EG_2", status: 4, error: "no workers" })).toMatchObject({ state: "failed", error: "no workers", file: null });
  });

  it("takes a webhook only when signed with the key and secret over this very body", () => {
    const body = JSON.stringify({ event: "participant_joined", room: { name: "abc", sid: "RM_1" }, participant: { identity: "u:1", name: "Emily" } });
    const auth = signWebhook(body, "meet", "secret");
    expect(readWebhook(body, auth, "meet", "secret")).toMatchObject({ event: "participant_joined", room: { name: "abc" }, participant: { identity: "u:1" } });
    expect(readWebhook(body, `Bearer ${auth}`, "meet", "secret")).not.toBeNull();
    expect(readWebhook(body.replace("Emily", "Mallory"), auth, "meet", "secret")).toBeNull();
    expect(readWebhook(body, auth, "other-key", "secret")).toBeNull();
    expect(readWebhook(body, auth, "meet", "other")).toBeNull();
    expect(readWebhook(body, undefined, "meet", "secret")).toBeNull();
    expect(readWebhook(body, auth, "meet", "")).toBeNull();
  });

  it("reads the process numbers from LiveKit's Prometheus endpoint", () => {
    const text = [
      "# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.",
      "process_cpu_seconds_total 123.5",
      "process_resident_memory_bytes 1.2e+09",
      "process_start_time_seconds 1762340400",
      'go_sched_gomaxprocs_threads{a="b"} 8',
    ].join("\n");
    expect(readProcessMetrics(text)).toEqual({ cpuSeconds: 123.5, memoryBytes: 1.2e9, startedAt: 1762340400000, cores: 8 });
    expect(readProcessMetrics("")).toEqual({ cpuSeconds: null, memoryBytes: null, startedAt: null, cores: null });
  });
});
