import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyJwt } from "./livekit.ts";
import { API_SECRET } from "./fake-livekit.ts";
import { codeOf, dayRange, slug } from "./meet.ts";
import { ALI, CALENDAR, EMILY, HAKAN, PAT, ROBERT, SELIN, SETTINGS, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

const claims = (token: string) => verifyJwt(token, API_SECRET, app.clock())! as Record<string, any>;

/** Emily makes a meeting, joins it, and LiveKit sees her come in. */
async function emilyInCall(body: Record<string, unknown> = { title: "Demo: Northwind", allowRecording: true }) {
  const m = (await app.as(EMILY)("POST", "/api/v1/meetings", body)).body;
  const j = await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/join`);
  expect(j.status).toBe(200);
  app.lk.join(m.id, j.body.identity, "Emily Clark");
  await app.meet.reconcile();
  return m as { id: string; url: string };
}

async function knock(id: string, name = "Mina Seo", email?: string) {
  const r = await app.as(null)("POST", `/api/v1/join/${id}/lobby`, { name, ...(email && { email }) });
  expect(r.status).toBe(201);
  return { ...r.body, as: app.as(null, { "x-lobby-ticket": r.body.ticket }) } as { id: string; ticket: string; as: ReturnType<TestApp["as"]> };
}

describe("links", () => {
  it("makes codes like abc-def-ghi, and reads them back from what people paste", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", {})).body;
    expect(m.id).toMatch(/^[a-z2-9]{3}-[a-z2-9]{3}-[a-z2-9]{3}$/);
    expect(m.url).toBe(`https://meet.example.com/${m.id}`);
    expect(m.title).toBe("Emily Clark");
    expect(codeOf("https://meet.example.com/k7f-3qd-wx2?x=1")).toBe("k7f-3qd-wx2");
    expect(codeOf("meet.example.com/emily-clark")).toBe("emily-clark");
    expect(codeOf(" K7F-3QD-WX2 ")).toBe("k7f-3qd-wx2");
    expect(codeOf("https://meet.example.com/settings")).toBeNull();
    expect(codeOf("")).toBeNull();
  });

  it("gives each person a room that stays theirs, by their name", async () => {
    const a = (await app.as(EMILY)("GET", "/api/v1/me")).body;
    const b = (await app.as(EMILY)("GET", "/api/v1/me")).body;
    expect(a.room.id).toBe("emily-clark");
    expect(b.room.id).toBe("emily-clark");
    expect(a.room.source).toBe("room");
    expect(slug("Hakan Yıldız")).toBe("hakan-yildiz");
    expect(slug("Şule Çağlar")).toBe("sule-caglar");
    expect((await app.as("admin")("GET", "/api/v1/me")).body.room).toBeNull();
  });

  it("finds a day's start in the time zone, also across a clock change", () => {
    expect(new Date(dayRange("2026-11-05", "Europe/Istanbul").from).toISOString()).toBe("2026-11-04T21:00:00.000Z");
    const berlin = dayRange("2026-10-25", "Europe/Berlin");
    expect(new Date(berlin.from).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(new Date(berlin.to).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("tokens and grants", () => {
  it("lets a signed-in member straight in, with a token for this room only", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", { title: "Stand-up" })).body;
    const j = (await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/join`)).body;
    expect(j.url).toBe("wss://rtc.example.com");
    expect(j.identity).toBe("u:user-emily");
    const c = claims(j.token);
    expect(c).toMatchObject({ iss: "meet-test", sub: "u:user-emily", name: "Emily Clark", metadata: '{"kind":"member"}' });
    expect(c.video).toEqual({
      roomJoin: true,
      room: m.id,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canPublishSources: ["camera", "microphone", "screen_share", "screen_share_audio"],
    });
    expect(c.video.roomAdmin).toBeUndefined();
    expect(c.video.roomRecord).toBeUndefined();
    expect(c.exp - c.nbf).toBe(900);
    // The room was made with the file's limits.
    const create = app.lk.state.calls.find((x) => x.method === "CreateRoom")!;
    expect(create.body).toMatchObject({ name: m.id, maxParticipants: 50 });
    expect(create.grant).toEqual({ roomCreate: true });
  });

  it("calls LiveKit's API with only the grant each call needs", async () => {
    await emilyInCall();
    const grants = Object.fromEntries(app.lk.state.calls.map((c) => [c.method, c.grant]));
    expect(grants.ListRooms).toEqual({ roomList: true });
    expect(grants.ListParticipants).toMatchObject({ roomAdmin: true, room: expect.any(String) });
  });

  it("gives API tokens no way into a call", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", {})).body;
    expect((await app.as("admin")("POST", `/api/v1/meetings/${m.id}/join`)).status).toBe(403);
  });

  it("says when there is no secret for LiveKit", async () => {
    const bare = await startApp();
    bare.meet.setConfig(bare.meet.config(), "");
    const meet = (await import("./meet.ts")).createMeet(bare.db, { publicUrl: "https://meet.example.com", env: {} });
    meet.setConfig(bare.meet.config(), "x: 1");
    const m = meet.create(EMILY, { title: "x" }).meeting;
    await expect(meet.join(EMILY, m.id)).rejects.toMatchObject({ status: 503, code: "media-server-unavailable" });
    await bare.close();
  });

  it("keeps to the number of live meetings the file allows", async () => {
    const limited = await startApp({ settings: SETTINGS.replace("meetings: 3", "meetings: 1") });
    const a = (await limited.as(EMILY)("POST", "/api/v1/meetings", {})).body.id;
    const b = (await limited.as(ROBERT)("POST", "/api/v1/meetings", {})).body.id;
    expect((await limited.as(EMILY)("POST", `/api/v1/meetings/${a}/join`)).status).toBe(200);
    expect((await limited.as(ALI)("POST", `/api/v1/meetings/${a}/join`)).status).toBe(200);
    const full = await limited.as(ROBERT)("POST", `/api/v1/meetings/${b}/join`);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("limit-reached");
    await limited.close();
  });
});

describe("the lobby", () => {
  it("lets a guest in only when someone in the call says so, and only while someone from the company is there", async () => {
    const m = await emilyInCall();
    const info = (await app.as(null)("GET", `/api/v1/join/${m.id}`)).body;
    expect(info).toMatchObject({ title: "Demo: Northwind", organization: "Acme Corp", guests: true, live: true, recording: false });
    const g = await knock(m.id, "Mina Seo", "Mina.Seo@northwind.example");
    expect((await g.as("GET", "/api/v1/lobby")).body).toMatchObject({ state: "waiting", join: null });
    const lobby = (await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}/lobby`)).body.waiting;
    expect(lobby).toEqual([{ id: g.id, name: "Mina Seo", email: "mina.seo@northwind.example", invited: false, since: expect.any(String) }]);
    // Someone not in the call and not the organiser does not see it.
    expect((await app.as(ALI)("GET", `/api/v1/meetings/${m.id}/lobby`)).status).toBe(403);
    expect((await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/lobby/${g.id}/admit`)).body).toEqual({ id: g.id, state: "admitted" });
    const status = (await g.as("GET", "/api/v1/lobby")).body;
    expect(status.state).toBe("admitted");
    const c = claims(status.join.token);
    expect(c.sub).toBe(`g:${g.id}`);
    expect(c.name).toBe("Mina Seo");
    expect(JSON.parse(c.metadata)).toEqual({ kind: "guest", domain: "northwind.example" });
    expect(c.video.room).toBe(m.id);
    expect(c.video.roomAdmin).toBeUndefined();

    // When Emily leaves, the guest gets no new token until someone from the company is back.
    app.lk.leave(m.id, "u:user-emily");
    expect((await g.as("GET", "/api/v1/lobby")).body).toMatchObject({ state: "admitted", join: null });
    app.lk.join(m.id, "u:user-ali", "Ali Demir");
    expect((await g.as("GET", "/api/v1/lobby")).body.join).not.toBeNull();
  });

  it("lets no one in while no one from the company is in the call", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", { title: "Early" })).body;
    const g = await knock(m.id);
    const r = await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/lobby/${g.id}/admit`);
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain("someone from the company");
  });

  it("says no, and a knock no one answers goes after the file's wait", async () => {
    const m = await emilyInCall();
    const a = await knock(m.id, "Leo Park");
    expect((await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/lobby/${a.id}/deny`)).body.state).toBe("denied");
    expect((await a.as("GET", "/api/v1/lobby")).body).toMatchObject({ state: "denied", join: null });
    const b = await knock(m.id, "Sam");
    app.clock.advance(11 * 60_000);
    expect((await b.as("GET", "/api/v1/lobby")).body.state).toBe("expired");
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}/lobby`)).body.waiting).toEqual([]);
  });

  it("marks invited guests, and tells guests a recording runs before they come in", async () => {
    const m = await emilyInCall({ title: "Board", allowRecording: true, invited: ["dana@northwind.example"] });
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/recording`);
    const g = await knock(m.id, "Dana Brooks", "dana@northwind.example");
    expect((await g.as("GET", "/api/v1/lobby")).body.meeting.recording).toBe(true);
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}/lobby`)).body.waiting[0].invited).toBe(true);
  });

  it("keeps no IP address, and forgets a guest's name when the call ends", async () => {
    const columns = (
      app.db.prepare("SELECT name FROM pragma_table_info('lobby') UNION SELECT name FROM pragma_table_info('attendance')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns.some((c) => /ip|address|agent/i.test(c))).toBe(false);
    const m = await emilyInCall();
    const g = await knock(m.id, "Mina Seo");
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/lobby/${g.id}/admit`);
    const w = app.lk.join(m.id, `g:${g.id}`, "Mina Seo");
    await app.hook(app.lk.webhook("participant_joined", w));
    expect(app.db.prepare("SELECT name FROM attendance WHERE kind = 'guest'").get()).toEqual({ name: "Mina Seo" });
    await app.hook(app.lk.webhook("room_finished", app.lk.close(m.id)));
    expect(app.db.prepare("SELECT name, left_at IS NOT NULL AS gone FROM attendance WHERE kind = 'guest'").get()).toEqual({ name: null, gone: 1 });
    expect((await g.as("GET", "/api/v1/lobby")).body.state).toBe("expired");
    // A day later the lobby entry itself is gone.
    app.clock.advance(25 * 3600_000);
    expect((await g.as("GET", "/api/v1/lobby")).status).toBe(404);
    const after = (await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body;
    expect(after).toMatchObject({ status: "ended", joined: 2, guests: 1 });
  });

  it("refuses guests when the file allows none", async () => {
    const closed = await startApp({ settings: SETTINGS.replace("guests: true", "guests: false") });
    const m = (await closed.as(EMILY)("POST", "/api/v1/meetings", {})).body;
    const r = await closed.as(null)("POST", `/api/v1/join/${m.id}/lobby`, { name: "Mina" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("guests-not-allowed");
    await closed.close();
  });
});

describe("who sees and changes what", () => {
  it("lists a member's own, invited and joined meetings; viewers see all", async () => {
    const own = (await app.as(EMILY)("POST", "/api/v1/meetings", { title: "Own" })).body.id;
    await app.as(CALENDAR)("POST", "/api/v1/meetings", {
      source: "calendar",
      reference: "uid-1",
      title: "Product review",
      organizer: { email: "robert@example.com" },
      startsAt: "2026-11-05T12:00:00Z",
      invited: ["emily@example.com"],
    });
    await app.as(ROBERT)("POST", "/api/v1/meetings", { title: "Robert's" });
    const emily = (await app.as(EMILY)("GET", "/api/v1/meetings")).body;
    expect(emily.meetings.map((m: { title: string }) => m.title).sort()).toEqual(["Own", "Product review"]);
    expect(emily.meetings.find((m: { id: string }) => m.id === own).you).toEqual({ organizer: true, invited: false, canManage: true });
    const hakan = (await app.as(HAKAN)("GET", "/api/v1/meetings")).body;
    expect(hakan.meetings).toHaveLength(3);
    expect(hakan.totals).toMatchObject({ meetings: 3, upcoming: 1 });
    expect((await app.as(ALI)("GET", `/api/v1/meetings/${own}`)).status).toBe(404);
  });

  it("lets Calendar make meetings for someone, once per event, and move them", async () => {
    const body = {
      source: "calendar",
      reference: "uid-2",
      title: "Interview",
      organizer: { email: "emily@example.com" },
      startsAt: "2026-11-06T07:30:00Z",
      endsAt: "2026-11-06T08:30:00Z",
      invited: ["candidate@example.net"],
      allowRecording: true,
    };
    const a = await app.as(CALENDAR)("POST", "/api/v1/meetings", body);
    const b = await app.as(CALENDAR)("POST", "/api/v1/meetings", body);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
    expect(a.body).toMatchObject({ organizer: { email: "emily@example.com", name: "Emily Clark" }, invited: 1, allowRecording: true, status: "upcoming" });
    const moved = await app.as(CALENDAR)("PATCH", `/api/v1/meetings/${a.body.id}`, { startsAt: "2026-11-06T09:00:00Z", endsAt: "2026-11-06T10:00:00Z" });
    expect(moved.body.startsAt).toBe("2026-11-06T09:00:00.000Z");
    // A member cannot make one for someone else; recording only where the organiser may.
    expect((await app.as(EMILY)("POST", "/api/v1/meetings", { organizer: { email: "ali@example.com" } })).status).toBe(403);
    expect((await app.as(CALENDAR)("POST", "/api/v1/meetings", { ...body, reference: "uid-3", organizer: { email: "ali@example.com" } })).status).toBe(403);
    expect((await app.as(CALENDAR)("DELETE", `/api/v1/meetings/${a.body.id}`)).status).toBe(204);
  });

  it("lets only the organiser or an editor change or delete a meeting", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", { title: "Mine", invited: ["ali@example.com"] })).body.id;
    expect((await app.as(ALI)("PATCH", `/api/v1/meetings/${m}`, { title: "Ali's" })).status).toBe(403);
    expect((await app.as(ALI)("DELETE", `/api/v1/meetings/${m}`)).status).toBe(403);
    expect((await app.as(EMILY)("PATCH", `/api/v1/meetings/${m}`, { title: "Ours" })).body.title).toBe("Ours");
    expect((await app.as(SELIN)("DELETE", `/api/v1/meetings/${m}`)).status).toBe(204);
  });

  it("deleting a live meeting closes its room for everyone", async () => {
    const m = await emilyInCall();
    expect((await app.as(EMILY)("DELETE", `/api/v1/meetings/${m.id}`)).status).toBe(204);
    expect(app.lk.state.rooms.has(m.id)).toBe(false);
  });

  it("keeps the Server page, the settings and the integrations for viewers", async () => {
    for (const p of ["/api/v1/server", "/api/v1/settings", "/api/v1/integrations"]) {
      expect((await app.as(EMILY)("GET", p)).status).toBe(403);
      expect((await app.as(HAKAN)("GET", p)).status).toBe(200);
    }
  });
});

describe("calls as LiveKit sees them", () => {
  it("counts who joined, guests and minutes, from webhooks", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", { title: "Incident call" })).body;
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/join`);
    await app.hook(app.lk.webhook("room_started", { room: app.lk.state.rooms.get(m.id) && { name: m.id, sid: app.lk.state.rooms.get(m.id)!.sid } }));
    await app.hook(app.lk.webhook("participant_joined", app.lk.join(m.id, "u:user-emily", "Emily Clark")));
    await app.hook(app.lk.webhook("participant_joined", app.lk.join(m.id, "u:user-ali", "Ali Demir")));
    // Egress's own participant is not counted.
    await app.hook(app.lk.webhook("participant_joined", app.lk.join(m.id, "EG_1", "")));
    let live = (await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body;
    expect(live).toMatchObject({ status: "live", joined: 2, inCall: { people: 2, guests: 0 } });
    app.clock.advance(34 * 60_000);
    await app.hook(app.lk.webhook("participant_left", app.lk.leave(m.id, "u:user-ali")));
    await app.hook(app.lk.webhook("room_finished", app.lk.close(m.id)));
    live = (await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body;
    expect(live).toMatchObject({ status: "ended", joined: 2, minutes: 34 });
    const list = (await app.as(EMILY)("GET", "/api/v1/meetings")).body;
    expect(list.totals).toMatchObject({ ended: 1, joined: 2, averageMinutes: 34 });
  });

  it("refuses webhooks not signed with the secret", async () => {
    const m = (await app.as(EMILY)("POST", "/api/v1/meetings", {})).body;
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/join`);
    const forged = app.lk.webhook("participant_joined", app.lk.join(m.id, "u:user-ali", "Ali"), "not-the-secret");
    expect((await app.hook(forged)).status).toBe(401);
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body.inCall.people).toBe(0);
  });

  it("works without webhooks: the check every 15 seconds sees people come and go and rooms close", async () => {
    const m = await emilyInCall();
    app.lk.join(m.id, "u:user-ali", "Ali Demir");
    await app.meet.reconcile();
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body.inCall.people).toBe(2);
    app.lk.close(m.id);
    await app.meet.reconcile();
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body).toMatchObject({ status: "ended", joined: 2 });
  });

  it("shows LiveKit as down on the Server page, and keeps serving", async () => {
    app.lk.state.down = 503;
    await app.meet.reconcile();
    const s = (await app.as(HAKAN)("GET", "/api/v1/server")).body;
    expect(s.livekit).toMatchObject({ ok: false, error: expect.stringContaining("503") });
    expect((await app.as(null)("GET", "/metrics")).body).toContain("openasy_meet_livekit_up 0");
  });

  it("adds up what browsers report, and what goes through TURN", async () => {
    const m = await emilyInCall();
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/stats`, {
      path: "udp",
      rttMs: 4,
      lossPercent: 0,
      sendKbps: 1500,
      receiveKbps: 2500,
      sending: "720p",
      browser: "Firefox 132",
    });
    const g = await knock(m.id, "Leo Park");
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/lobby/${g.id}/admit`);
    await g.as("POST", "/api/v1/lobby/stats", {
      path: "turn-tls",
      rttMs: 284,
      lossPercent: 3.8,
      sendKbps: 40,
      receiveKbps: 960,
      sending: "Audio only",
      browser: "Safari on iPhone",
    });
    app.meet.sampleMedia();
    await app.meet.checkTurnNow();
    const s = (await app.as(HAKAN)("GET", "/api/v1/server")).body;
    expect(s.bandwidth.nowMbps).toBe(5);
    expect(s.bandwidth.samples.at(-1)).toMatchObject({ totalMbps: 5, relayedMbps: 1 });
    expect(s.connections.map((c: { name: string; path: string; guest: boolean }) => [c.name, c.path, c.guest])).toEqual([
      ["Emily Clark", "udp", false],
      ["Leo Park", "turn-tls", true],
    ]);
    expect(s.turn).toHaveLength(2);
    expect(s.turn.every((t: { ok: boolean }) => t.ok)).toBe(true);
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body.media).toEqual({ direct: 1, relayed: 1 });
    // Reports are not kept: after 90 seconds without one, a connection is gone.
    app.clock.advance(91_000);
    expect((await app.as(HAKAN)("GET", "/api/v1/server")).body.connections).toEqual([]);
  });
});

describe("recordings", () => {
  it("are for organisers whose group the file allows, with that group's days", async () => {
    expect((await app.as(EMILY)("GET", "/api/v1/me")).body.recording).toEqual({ allowed: true, group: "sales", groupName: "Sales", keepDays: 30 });
    expect((await app.as(ROBERT)("GET", "/api/v1/me")).body.recording).toMatchObject({ allowed: true, group: "leadership", keepDays: 90 });
    expect((await app.as(PAT)("GET", "/api/v1/me")).body.recording).toEqual({
      allowed: false,
      reason: "never",
      group: "people-team",
      groupName: "People team",
    });
    expect((await app.as(ALI)("GET", "/api/v1/me")).body.recording).toMatchObject({ allowed: false, reason: "not-in-group" });
    expect((await app.as(PAT)("POST", "/api/v1/meetings", { allowRecording: true })).status).toBe(403);
    // A group from the identity provider counts too.
    app.meet.noteGroups(ALI.id, ["Leadership"]);
    expect((await app.as(ALI)("GET", "/api/v1/me")).body.recording).toMatchObject({ allowed: true, group: "leadership" });
  });

  it("start only when the meeting allows it, by its organiser, while it is live", async () => {
    const m = await emilyInCall({ title: "No recording" });
    expect((await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/recording`)).status).toBe(403);
    const n = (await app.as(EMILY)("POST", "/api/v1/meetings", { title: "Later", allowRecording: true })).body;
    expect((await app.as(EMILY)("POST", `/api/v1/meetings/${n.id}/recording`)).status).toBe(409);
  });

  it("list who saw the mark, delete the file on its day, and never before unless asked", async () => {
    const m = await emilyInCall();
    const g = await knock(m.id, "Dana Brooks");
    await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/lobby/${g.id}/admit`);
    await app.hook(app.lk.webhook("participant_joined", app.lk.join(m.id, `g:${g.id}`, "Dana Brooks")));
    const r = await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/recording`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: "recording", group: { id: "sales", name: "Sales", keepDays: 30 }, people: ["Emily Clark"], guests: 1 });
    const start = app.lk.state.calls.find((c) => c.method === "StartRoomCompositeEgress")!;
    expect(start.grant).toEqual({ roomRecord: true });
    expect(start.body).toMatchObject({ roomName: m.id, layout: "speaker", fileOutputs: [{ fileType: "MP4", filepath: `${app.storage}/${r.body.id}.mp4` }] });
    expect((await app.as(EMILY)("GET", `/api/v1/meetings/${m.id}`)).body.recording).toBe(true);
    // Someone who comes in while it runs is listed with it.
    await app.hook(app.lk.webhook("participant_joined", app.lk.join(m.id, "u:user-ali", "Ali Demir")));
    expect((await app.as(ALI)("GET", `/api/v1/recordings/${r.body.id}`)).body.people).toEqual(["Emily Clark", "Ali Demir"]);

    await app.as(EMILY)("DELETE", `/api/v1/meetings/${m.id}/recording`);
    const egress = [...app.lk.state.egress.values()][0]!;
    writeFileSync(egress.filepath, Buffer.alloc(4096, 1));
    // Without the webhook, the check every 15 seconds sees Egress finish.
    app.lk.finishEgress(egress.egressId);
    await app.meet.reconcile();
    const saved = (await app.as(EMILY)("GET", `/api/v1/recordings/${r.body.id}`)).body;
    expect(saved).toMatchObject({ state: "ready", size: 1048576, seconds: expect.any(Number), canDelete: true });
    const list = (await app.as(EMILY)("GET", "/api/v1/recordings")).body;
    expect(list.totals).toMatchObject({ kept: 1, nextDeletion: { title: "Demo: Northwind", keepDays: 30 } });
    expect(list.policy.yaml).toContain("never_for");
    // Robert was not in it and is no viewer: he does not see it.
    expect((await app.as(ROBERT)("GET", "/api/v1/recordings")).body.recordings).toEqual([]);
    const file = await app.as(EMILY)("GET", `/api/v1/recordings/${r.body.id}/file`);
    expect(file.headers.get("content-type")).toBe("video/mp4");
    expect(file.headers.get("content-disposition")).toContain("Demo%20Northwind%202026-11-05.mp4");

    app.meet.retention();
    expect(existsSync(egress.filepath)).toBe(true);
    app.clock.set(Date.parse(saved.deleteOn) + 1000);
    app.meet.retention();
    expect(existsSync(egress.filepath)).toBe(false);
    expect((await app.as(EMILY)("GET", `/api/v1/recordings/${r.body.id}`)).status).toBe(404);
  });

  it("are deleted at once by who started them or an admin", async () => {
    const m = await emilyInCall();
    const r = (await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/recording`)).body;
    const egress = [...app.lk.state.egress.values()][0]!;
    writeFileSync(egress.filepath, "x");
    await app.hook(app.lk.webhook("egress_ended", { egress_info: app.lk.finishEgress(egress.egressId) }));
    expect((await app.as(HAKAN)("DELETE", `/api/v1/recordings/${r.id}`)).status).toBe(403);
    expect((await app.as(EMILY)("DELETE", `/api/v1/recordings/${r.id}`)).status).toBe(204);
    expect(existsSync(egress.filepath)).toBe(false);
  });

  it("say when Egress failed", async () => {
    const m = await emilyInCall();
    const r = (await app.as(EMILY)("POST", `/api/v1/meetings/${m.id}/recording`)).body;
    const egress = [...app.lk.state.egress.values()][0]!;
    await app.hook(app.lk.webhook("egress_ended", { egress_info: app.lk.finishEgress(egress.egressId, "EGRESS_FAILED", "Chrome crashed") }));
    expect((await app.as(EMILY)("GET", `/api/v1/recordings/${r.id}`)).body).toMatchObject({ state: "failed", error: "Chrome crashed", deleteOn: null });
  });

  it("are off without a recording part in the file", async () => {
    const off = await startApp({ settings: SETTINGS.replace(/recording:[\s\S]*?announce: true\n/, "") });
    expect((await off.as(EMILY)("GET", "/api/v1/me")).body.recording).toMatchObject({ allowed: false, reason: "off" });
    expect((await off.as(HAKAN)("GET", "/api/v1/recordings")).body.policy).toMatchObject({ on: false, yaml: "recording: off" });
    await off.close();
  });
});

describe("the pages' security headers", () => {
  it("allow connecting to LiveKit's address from the file and nothing else outside", async () => {
    const r = await app.as(null)("GET", "/api/v1/version");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self' wss://rtc.example.com https://rtc.example.com;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("permissions-policy")).toContain("camera=(self)");
  });
});
