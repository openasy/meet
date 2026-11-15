// End to end against a running LiveKit (e2e/run.sh starts one): Meet's server with its API pointed at it. Tokens Meet
// mints are checked by LiveKit itself, rooms open within the file's limits, people joined with LiveKit's command line
// tool are seen through webhooks and the check every 15 seconds, a guest comes in through the lobby, the call ends
// when the last one leaves and the guest's name is forgotten, and, with Egress (E2E_EGRESS=1), a recording is made,
// saved, served and deleted.
//
//   LK_PORT=17880 MEET_PORT=18299 SECRET=... NET=meet-e2e DIR=/tmp/x CLI_IMAGE=livekit/livekit-cli:v2.19.1 node e2e/livekit.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth } from "@openasy/auth";
import { createApp } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { createMeet, type Actor } from "../server/meet.ts";

const LK = `http://localhost:${process.env.LK_PORT ?? "17880"}`;
const PORT = Number(process.env.MEET_PORT ?? 18299);
const SECRET = process.env.SECRET ?? "";
const NET = process.env.NET ?? "meet-e2e";
const DIR = process.env.DIR ?? "/tmp";
const CLI = process.env.CLI_IMAGE ?? "livekit/livekit-cli:v2.19.1";
const EGRESS = !!process.env.EGRESS;

let failures = 0;
async function step(name: string, work: () => Promise<void>) {
  try {
    await work();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${(err as Error).stack?.split("\n").slice(0, 6).join("\n  ")}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(work: () => Promise<T>, tries = 40, every = 1000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(every);
    }
  }
}

const EMILY: Actor = { id: "user-emily", name: "Emily Clark", role: "user", email: "emily@example.com" };
const ALI: Actor = { id: "user-ali", name: "Ali Demir", role: "user", email: "ali@example.com" };
const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "admin", email: "selin@example.com" };

const db = openDb(":memory:");
const base = `http://localhost:${PORT}`;
const auth = createAuth({ db, product: "meet", productName: "OpenAsy Meet", origin: base, users: true });
for (const m of [EMILY, ALI, SELIN])
  db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
    m.id,
    m.email,
    m.name,
    m.role,
    new Date().toISOString(),
  );
const meet = createMeet(db, { publicUrl: "https://meet.example.com", env: { MEET_LIVEKIT_SECRET: SECRET } });
const yaml = `
organization: Acme Corp
livekit: { url: ${LK}, public_url: ws://localhost:${process.env.LK_PORT ?? "17880"}, api_key: meet, api_secret: MEET_LIVEKIT_SECRET, metrics_url: http://localhost:${Number(process.env.LK_PORT ?? 17880) + 1}/metrics }
limits: { meetings: 2, people: 10 }
groups: { sales: [emily@example.com] }
recording: { allowed_for: [{ group: sales, keep_days: 30 }], storage: ${DIR} }
`;
meet.setConfig(parseConfig(yaml).config, yaml);
const tokens: Record<string, Actor> = { emily: EMILY, ali: ALI, selin: SELIN };
const server = createServer(createApp({ db, meet, auth, version: "e2e", testTokens: tokens }));
await new Promise<void>((r) => server.listen(PORT, r));

async function api(who: keyof typeof tokens | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(who && { authorization: `Bearer ${who}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}
/** Does LiveKit itself take this token for joining? Its own check, the one livekit-client uses. */
const validate = async (token: string) => (await fetch(`${LK}/rtc/validate?access_token=${encodeURIComponent(token)}`)).status;

const people: string[] = [];
/** Someone in the room with media, as a browser would be: LiveKit's command line tool, publishing a test video. */
function joinRoom(room: string, identity: string) {
  const name = `meet-e2e-p-${people.length}`;
  people.push(name);
  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    NET,
    CLI,
    "room",
    "join",
    "--url",
    "ws://meet-e2e-lk:7880",
    "--api-key",
    "meet",
    "--api-secret",
    SECRET,
    "--identity",
    identity,
    "--publish-demo",
    room,
  ]);
  return name;
}
const leaveRoom = (name: string) => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });

let id = "";
let guest = { id: "", ticket: "" };

await step("Emily makes a meeting and gets a token LiveKit takes, for this room only", async () => {
  const m = await api("emily", "POST", "/api/v1/meetings", { title: "Demo: Northwind", allowRecording: true });
  assert.equal(m.status, 201);
  id = m.body.id;
  const j = await api("emily", "POST", `/api/v1/meetings/${id}/join`);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(await validate(j.body.token), 200);
  // A token signed with another secret is refused by LiveKit.
  const forged = j.body.token.split(".").slice(0, 2).join(".") + ".AAAA";
  assert.notEqual(await validate(forged), 200);
  await meet.reconcile();
  assert.equal((await api("emily", "GET", `/api/v1/meetings/${id}`)).body.status, "live");
});

await step("LiveKit's server API answers, and the Server page reads its metrics", async () => {
  await meet.sampleMetrics();
  const s = (await api("selin", "GET", "/api/v1/server")).body;
  assert.equal(s.livekit.ok, true);
  assert.ok(s.livekit.rooms >= 1);
  assert.ok(s.livekit.memoryBytes > 0, "process_resident_memory_bytes read");
});

await step("people in the room are seen through webhooks", async () => {
  joinRoom(id, "u:user-emily");
  await eventually(async () => {
    const m = (await api("emily", "GET", `/api/v1/meetings/${id}`)).body;
    assert.equal(m.inCall.people, 1);
  });
  assert.ok(meet.integrations().webhooks.count > 0, "a webhook came");
});

await step("a guest knocks, Emily lets them in, and LiveKit takes the guest's token", async () => {
  const k = await api(null, "POST", `/api/v1/join/${id}/lobby`, { name: "Mina Seo", email: "mina@northwind.example" });
  assert.equal(k.status, 201);
  guest = { id: k.body.id, ticket: k.body.ticket };
  const lobby = await api("emily", "GET", `/api/v1/meetings/${id}/lobby`);
  assert.deepEqual(
    lobby.body.waiting.map((w: { name: string }) => w.name),
    ["Mina Seo"],
  );
  assert.equal((await api("ali", "GET", `/api/v1/meetings/${id}/lobby`)).status, 403);
  assert.equal((await api("emily", "POST", `/api/v1/meetings/${id}/lobby/${guest.id}/admit`)).status, 200);
  const s = await api(null, "GET", "/api/v1/lobby", undefined, { "x-lobby-ticket": guest.ticket });
  assert.equal(s.body.state, "admitted");
  assert.equal(await validate(s.body.join.token), 200);
  joinRoom(id, `g:${guest.id}`);
  await eventually(async () => assert.equal((await api("emily", "GET", `/api/v1/meetings/${id}`)).body.inCall.guests, 1));
});

await step("the file's limit on live meetings holds against LiveKit", async () => {
  const a = (await api("ali", "POST", "/api/v1/meetings", { title: "Second" })).body.id;
  assert.equal((await api("ali", "POST", `/api/v1/meetings/${a}/join`)).status, 200);
  const b = (await api("ali", "POST", "/api/v1/meetings", { title: "Third" })).body.id;
  assert.equal((await api("ali", "POST", `/api/v1/meetings/${b}/join`)).status, 409);
  // Deleting a live meeting closes its room in LiveKit.
  assert.equal((await api("ali", "DELETE", `/api/v1/meetings/${a}`)).status, 204);
  await meet.reconcile();
  const rooms = (await api("selin", "GET", "/api/v1/server")).body.live.meetings;
  assert.equal(rooms, 1);
});

if (EGRESS)
  await step("Egress records the room where the file allows it; the file is served, then deleted", async () => {
    const r = await api("emily", "POST", `/api/v1/meetings/${id}/recording`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await eventually(async () => assert.equal((await api(null, "GET", `/api/v1/join/${id}`)).body.recording, true));
    await sleep(8000);
    assert.equal((await api("emily", "DELETE", `/api/v1/meetings/${id}/recording`)).status, 200);
    const saved = await eventually(
      async () => {
        await meet.reconcile();
        const x = (await api("emily", "GET", `/api/v1/recordings/${r.body.id}`)).body;
        assert.equal(x.state, "ready", JSON.stringify(x));
        return x;
      },
      60,
      2000,
    );
    assert.ok(saved.size > 0);
    assert.ok(saved.people.includes("Emily Clark"));
    const file = await fetch(`${base}/api/v1/recordings/${r.body.id}/file`, { headers: { authorization: "Bearer emily", range: "bytes=0-11" } });
    assert.equal(file.status, 206);
    assert.equal(
      Buffer.from(await file.arrayBuffer())
        .subarray(4, 8)
        .toString(),
      "ftyp",
    );
    assert.equal((await api("emily", "DELETE", `/api/v1/recordings/${r.body.id}`)).status, 204);
    assert.equal(existsSync(`${DIR}/${r.body.id}.mp4`), false);
  });

await step("the call ends when the last one leaves, and nothing of the guest stays but the count", async () => {
  for (const p of people) leaveRoom(p);
  await eventually(
    async () => {
      await meet.reconcile();
      const m = (await api("emily", "GET", `/api/v1/meetings/${id}`)).body;
      assert.equal(m.status, "ended");
      assert.equal(m.joined, 2);
      assert.equal(m.guests, 1);
    },
    60,
    1000,
  );
  assert.deepEqual(
    db
      .prepare("SELECT name FROM attendance WHERE kind = 'guest'")
      .all()
      .map((r) => ({ ...r })),
    [{ name: null }],
  );
  assert.equal((await api(null, "GET", "/api/v1/lobby", undefined, { "x-lobby-ticket": guest.ticket })).body.state, "expired");
});

server.close();
console.log(failures ? `# ${failures} failed` : "# all passed");
process.exit(failures ? 1 : 0);
