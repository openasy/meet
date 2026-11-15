// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const en = (...values: string[]) => ({ type: "string", enum: values });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const noContent = (description: string) => ({ description });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const path = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: str });
const ID = [path("id", "The meeting's id: the last part of its link, such as k7f-3qd-wx2 or emily-clark.")];
const REC = [path("id", "The recording's id.")];
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const TICKET = { name: "X-Lobby-Ticket", in: "header", required: true, description: "The ticket the knock answered with.", schema: str };

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "user" | "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, role === "user" ? "Any member (the user role is enough)." : `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const Link = { ok: nul(bool), at: nul(dt), error: nul(str) };
const Person = obj({ email: str, name: str });
const Meeting = obj({
  id: str,
  url: { type: "string", description: "The link to share: anyone with it may ask to join.", examples: ["https://meet.example.com/k7f-3qd-wx2"] },
  title: str,
  source: { ...en("calendar", "chat", "hand", "room"), description: "Where the link came from; room is a person's own room." },
  channel: nul({ type: "string", description: "The Chat channel a call was started from, such as #support." }),
  reference: nul({ type: "string", description: "The id Calendar or Chat gave it, such as the event's UID." }),
  organizer: Person,
  startsAt: nul(dt),
  endsAt: nul(dt),
  at: { ...dt, description: "When it started (its first call that day), or starts, or the link was made." },
  invited: nul({ type: "integer", description: "People on the invitation; null when there is none." }),
  status: en("live", "upcoming", "ended"),
  joined: { type: "integer", description: "People who joined: in the day listed, or in the latest call." },
  guests: { type: "integer", description: "Of those, how many came in through the lobby." },
  minutes: nul({ type: "integer", description: "Length of its calls, so far for a live one." }),
  inCall: obj({ people: int, guests: int }),
  startedAt: nul(dt),
  lobby: { type: "integer", description: "People waiting in the lobby now." },
  allowRecording: { type: "boolean", description: "The organiser allowed recording when the meeting was made." },
  recording: { type: "boolean", description: "A recording runs now." },
  recorded: bool,
  admitted: nul(obj({ by: str, at: dt })),
  media: obj({ direct: int, relayed: { type: "integer", description: "Connections through TURN." } }),
  createdAt: dt,
  you: obj({ organizer: bool, invited: bool, canManage: bool }),
});
const JoinInfo = obj({
  id: str,
  title: str,
  organization: nul(str),
  organizer: str,
  guests: { type: "boolean", description: "Whether people without an account may ask to join." },
  live: bool,
  recording: { type: "boolean", description: "A recording runs now: people are told before they come in." },
  allowRecording: bool,
});
const Access = obj({
  url: { type: "string", description: "LiveKit's address for browsers, wss://." },
  identity: { type: "string", description: "u:<member id> or g:<lobby id>." },
  token: { type: "string", description: "A LiveKit access token for this room only, valid 15 minutes for joining; LiveKit renews it while connected." },
});
const Recording = obj({
  id: str,
  meetingId: nul(str),
  title: str,
  state: en("recording", "saving", "ready", "failed"),
  startedBy: Person,
  group: obj({ id: str, name: str, keepDays: int }),
  startedAt: dt,
  endedAt: nul(dt),
  seconds: int,
  size: { type: "integer", description: "Bytes." },
  file: str,
  people: { ...arr(str), description: "Members who were in the call while it ran and saw the mark." },
  guests: { type: "integer", description: "Guests who were in it; they were told in the lobby." },
  deleteOn: nul(dt),
  error: nul(str),
  canDelete: bool,
});
const MeetingInput = {
  type: "object",
  properties: {
    title: str,
    source: { ...en("calendar", "chat", "hand"), description: "hand when left out." },
    channel: str,
    reference: { type: "string", description: "Calendar's or Chat's own id: a second request with it answers the meeting made the first time." },
    organizer: { ...obj({ email: str, name: str }, ["email"]), description: "For editors' tokens (Calendar, Chat): who the meeting is for." },
    startsAt: dt,
    endsAt: dt,
    invited: arr(str),
    allowRecording: { type: "boolean", description: "Only when meet.yaml lets the organiser record." },
  },
};

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "forbidden",
          "not-found",
          "conflict",
          "limit-reached",
          "guests-not-allowed",
          "rate-limited",
          "media-server-unavailable",
          "payload-too-large",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
        ],
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "meet" }, version: str }),
  Products: obj({ products: arr(obj({ id: str, url: str })) }),
  Meeting,
  MeetingInput,
  MeetingList: obj({
    day: { type: "string", format: "date" },
    timeZone: str,
    meetings: arr(ref("Meeting")),
    totals: obj({
      meetings: int,
      live: int,
      upcoming: int,
      ended: int,
      joined: int,
      guests: int,
      averageMinutes: nul(int),
      recorded: int,
      firstRecorded: nul(obj({ title: str, group: nul(str) })),
    }),
  }),
  Me: obj({
    member: obj({ id: str, name: str, email: nul(str), role: en("user", "viewer", "editor", "admin", "owner") }),
    organization: nul(str),
    groups: arr(obj({ id: str, name: str })),
    recording: {
      description: "Whether meet.yaml lets this person record their meetings, and for how long the file is kept.",
      anyOf: [
        obj({ allowed: { const: true }, group: str, groupName: str, keepDays: int }),
        obj({ allowed: { const: false }, reason: en("off", "never", "not-in-group"), group: nul(str), groupName: nul(str) }),
      ],
    },
    room: { ...nul(ref("Meeting")), description: "The person's own room; null for an API token." },
    guests: bool,
    limits: obj({ people: int, video: en("360p", "540p", "720p", "1080p") }),
    media: obj({ url: str, host: nul(str) }),
  }),
  Join: { ...obj({ ...Access.properties, meeting: ref("Meeting") }), description: "What a browser needs to join the call with livekit-client." },
  JoinInfo,
  LobbyStatus: obj({
    id: str,
    state: en("waiting", "admitted", "denied", "expired", "left"),
    meeting: ref("JoinInfo"),
    join: { ...nul(Access), description: "Once let in, and while someone from the company is in the call." },
  }),
  Knock: obj({
    ticket: { type: "string", description: "The guest's place in the lobby: send it in X-Lobby-Ticket. Shown once." },
    id: str,
    state: en("waiting"),
    meeting: ref("JoinInfo"),
  }),
  Lobby: obj({
    waiting: arr(obj({ id: str, name: str, email: nul(str), invited: { type: "boolean", description: "Their email is on the invitation." }, since: dt })),
  }),
  Decision: obj({ id: str, state: en("admitted", "denied") }),
  Stats: {
    type: "object",
    description: "How a browser connects, every few seconds while in a call: shown on the Server page for 90 seconds and not kept.",
    properties: {
      path: en("udp", "tcp", "turn-udp", "turn-tcp", "turn-tls", "unknown"),
      rttMs: num,
      lossPercent: num,
      sendKbps: num,
      receiveKbps: num,
      sending: { type: "string", description: "What it sends: camera:720p, screen:1080p, audio or none." },
      browser: { type: "string", description: "Such as Firefox 132 or Safari on iPhone." },
    },
  },
  Recording,
  RecordingList: obj({
    recordings: arr(ref("Recording")),
    totals: obj({
      kept: int,
      bytes: int,
      capacity: nul({ type: "integer", description: "Size of the storage folder's disk, in bytes." }),
      meetingsLast30Days: int,
      nextDeletion: nul(obj({ on: dt, title: str, keepDays: int })),
    }),
    policy: obj({
      on: bool,
      groups: arr(obj({ id: str, name: str, keepDays: int })),
      never: arr(obj({ id: str, name: str })),
      yaml: { type: "string", description: "The recording part of meet.yaml as applied." },
    }),
  }),
  Server: obj({
    livekit: obj({
      url: str,
      publicUrl: str,
      ...Link,
      ms: nul(int),
      rooms: int,
      mediaPorts: nul(str),
      cpuPercent: nul(num),
      cores: nul(num),
      memoryBytes: nul(num),
      startedAt: nul(dt),
      metrics: nul(obj(Link)),
    }),
    limits: obj({ meetings: int, people: int, video: str, bandwidth: nul(num) }),
    live: obj({ meetings: int, people: int, lobby: int }),
    bandwidth: obj({ nowMbps: num, capacityMbps: nul(num), samples: arr(obj({ at: dt, totalMbps: num, relayedMbps: num })) }),
    turn: arr(obj({ host: str, port: int, transport: en("udp", "tcp", "tls"), ok: nul(bool), ms: nul(int), error: nul(str), at: nul(dt) })),
    connections: arr(
      obj({
        identity: str,
        name: str,
        guest: bool,
        meetingId: str,
        meeting: str,
        path: en("udp", "tcp", "turn-udp", "turn-tcp", "turn-tls", "unknown"),
        rttMs: nul(num),
        lossPercent: nul(num),
        sending: str,
        browser: str,
        at: dt,
      }),
    ),
  }),
  Integrations: obj({
    livekit: obj({ url: str, publicUrl: str, secret: bool, ...Link, ms: nul(int), rooms: int }),
    webhooks: obj({ url: str, ...Link, count: int, last: nul(str) }),
    egress: obj({ on: bool, storage: nul(str), ...Link }),
    metrics: obj({ url: nul(str), ...Link }),
    identity: obj({ peopleWithGroups: int, fileGroups: int }),
    turn: obj({ listeners: int, reachable: int }),
    api: obj({ meetings: str }),
  }),
  Settings: obj({
    file: nul(obj({ path: str, appliedAt: nul(dt), error: nul(str), warnings: arr(str) })),
    yaml: str,
    config: { type: "object", description: "meet.yaml as applied, with defaults filled in. The API secret is only named, never given." },
  }),
};

const paths: Record<string, S> = {
  "/api/v1/version": {
    get: pub({ operationId: "version", tags: ["Product"], summary: "The product and its version", responses: { "200": ok(ref("Version")) } }),
  },
  "/api/v1/products": {
    get: op("user", {
      operationId: "products",
      tags: ["Product"],
      summary: "The install's other OpenAsy products, for the switcher",
      responses: { "200": ok(ref("Products")) },
    }),
  },
  "/api/v1/me": {
    get: op("user", {
      operationId: "me",
      tags: ["Meetings"],
      summary: "Who I am here: my groups, whether I may record, and my own room",
      responses: { "200": ok(ref("Me")) },
    }),
  },
  "/api/v1/meetings": {
    get: op("user", {
      operationId: "listMeetings",
      tags: ["Meetings"],
      summary: "A day's meetings, with how many joined",
      description: "Viewers see every meeting; members those they organise, are invited to or joined. The day is in meet.yaml's time zone.",
      parameters: [query("day", "YYYY-MM-DD; today when left out.", { type: "string", format: "date" })],
      responses: { "200": ok(ref("MeetingList")), "422": problem },
    }),
    post: op("user", {
      operationId: "createMeeting",
      tags: ["Meetings"],
      summary: "Make a meeting link",
      description:
        "A member makes one for themselves. Calendar and Chat make them with an editor's token, for an organiser, with the event's or channel's id as reference.",
      requestBody: json(ref("MeetingInput")),
      responses: { "201": ok(ref("Meeting"), "Made."), "200": ok(ref("Meeting"), "Made before with this reference."), "400": problem, "422": problem },
    }),
  },
  "/api/v1/meetings/{id}": {
    get: op("user", {
      operationId: "getMeeting",
      tags: ["Meetings"],
      summary: "A meeting and its latest call",
      parameters: ID,
      responses: { "200": ok(ref("Meeting")), "404": problem },
    }),
    patch: op("user", {
      operationId: "updateMeeting",
      tags: ["Meetings"],
      summary: "Change a meeting's title, times, invitation or recording",
      description: "The organiser or an editor, such as Calendar when the event moves.",
      parameters: ID,
      requestBody: json(ref("MeetingInput")),
      responses: { "200": ok(ref("Meeting")), "400": problem, "404": problem, "422": problem },
    }),
    delete: op("user", {
      operationId: "deleteMeeting",
      tags: ["Meetings"],
      summary: "Delete a meeting; a live call ends for everyone",
      parameters: ID,
      responses: { "204": noContent("Deleted."), "404": problem, "503": problem },
    }),
  },
  "/api/v1/meetings/{id}/join": {
    post: op("user", {
      operationId: "joinMeeting",
      tags: ["Calls"],
      summary: "Join as a signed-in member, past the lobby",
      description: "Opens the room in LiveKit within meet.yaml's limits and answers a token for this room only. Only people, not API tokens.",
      parameters: ID,
      responses: { "200": ok(ref("Join")), "404": problem, "409": problem, "503": problem },
    }),
  },
  "/api/v1/meetings/{id}/lobby": {
    get: op("user", {
      operationId: "lobby",
      tags: ["Lobby"],
      summary: "Who waits to be let in",
      description: "The organiser, an admin, or a member in the call.",
      parameters: ID,
      responses: { "200": ok(ref("Lobby")), "404": problem },
    }),
  },
  "/api/v1/meetings/{id}/lobby/{entry}/admit": {
    post: op("user", {
      operationId: "admit",
      tags: ["Lobby"],
      summary: "Let a guest in",
      description: "Only while someone from the company is in the call.",
      parameters: [...ID, path("entry", "The lobby entry's id.")],
      responses: { "200": ok(ref("Decision")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/meetings/{id}/lobby/{entry}/deny": {
    post: op("user", {
      operationId: "deny",
      tags: ["Lobby"],
      summary: "Do not let a guest in",
      parameters: [...ID, path("entry", "The lobby entry's id.")],
      responses: { "200": ok(ref("Decision")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/meetings/{id}/recording": {
    post: op("user", {
      operationId: "startRecording",
      tags: ["Recordings"],
      summary: "Start recording the call",
      description: "The organiser, when the meeting allows it and meet.yaml lets them record. Egress records the room; everyone sees the mark.",
      parameters: ID,
      responses: { "201": ok(ref("Recording"), "Started."), "404": problem, "409": problem, "503": problem },
    }),
    delete: op("user", {
      operationId: "stopRecording",
      tags: ["Recordings"],
      summary: "Stop the recording",
      parameters: ID,
      responses: { "200": ok(ref("Recording")), "404": problem, "409": problem, "503": problem },
    }),
  },
  "/api/v1/meetings/{id}/stats": {
    post: op("user", {
      operationId: "memberStats",
      tags: ["Calls"],
      summary: "How my browser connects to the call",
      parameters: ID,
      requestBody: json(ref("Stats")),
      responses: { "204": noContent("Noted."), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/join/{id}": {
    get: pub({
      operationId: "joinInfo",
      tags: ["Lobby"],
      summary: "What a guest sees before asking to join",
      parameters: ID,
      responses: { "200": ok(ref("JoinInfo")), "404": problem },
    }),
  },
  "/api/v1/join/{id}/lobby": {
    post: pub({
      operationId: "knock",
      tags: ["Lobby"],
      summary: "Ask to join as a guest",
      description: "Only the name and, if given, the email are kept, until the call ends. No IP address is stored.",
      parameters: ID,
      requestBody: json(obj({ name: str, email: str }, ["name"])),
      responses: { "201": ok(ref("Knock"), "Waiting."), "400": problem, "403": problem, "404": problem, "413": problem, "422": problem, "429": problem },
    }),
  },
  "/api/v1/lobby": {
    get: pub({
      operationId: "lobbyStatus",
      tags: ["Lobby"],
      summary: "A guest's place in the lobby, and the token once let in",
      parameters: [TICKET],
      responses: { "200": ok(ref("LobbyStatus")), "401": problem, "404": problem },
    }),
    delete: pub({
      operationId: "leaveLobby",
      tags: ["Lobby"],
      summary: "Stop waiting",
      parameters: [TICKET],
      responses: { "204": noContent("Left."), "401": problem, "404": problem },
    }),
  },
  "/api/v1/lobby/stats": {
    post: pub({
      operationId: "guestStats",
      tags: ["Lobby"],
      summary: "How a guest's browser connects to the call",
      parameters: [TICKET],
      requestBody: json(ref("Stats")),
      responses: { "204": noContent("Noted."), "400": problem, "401": problem, "404": problem, "409": problem, "413": problem, "422": problem },
    }),
  },
  "/api/v1/livekit/webhook": {
    post: pub({
      operationId: "livekitWebhook",
      tags: ["LiveKit"],
      summary: "LiveKit's webhooks: rooms, participants and Egress",
      description: "Signed by LiveKit with the API key and secret: the Authorization header is a JWT whose sha256 claim is the body's hash.",
      requestBody: { required: true, content: { "application/webhook+json": { schema: { type: "object" } } } },
      responses: { "204": noContent("Read."), "401": problem, "413": problem },
    }),
  },
  "/api/v1/recordings": {
    get: op("user", {
      operationId: "listRecordings",
      tags: ["Recordings"],
      summary: "Recordings, who allowed them and when each is deleted",
      description: "Viewers see all; members the ones they started or were in.",
      parameters: [query("q", "Words in the meeting's title or who started it.")],
      responses: { "200": ok(ref("RecordingList")) },
    }),
  },
  "/api/v1/recordings/{id}": {
    get: op("user", {
      operationId: "getRecording",
      tags: ["Recordings"],
      summary: "A recording",
      parameters: REC,
      responses: { "200": ok(ref("Recording")), "404": problem },
    }),
    delete: op("user", {
      operationId: "deleteRecording",
      tags: ["Recordings"],
      summary: "Delete a recording now, before its day",
      description: "Who started it, or an admin.",
      parameters: REC,
      responses: { "204": noContent("Deleted."), "404": problem, "409": problem, "503": problem },
    }),
  },
  "/api/v1/recordings/{id}/file": {
    get: op("user", {
      operationId: "downloadRecording",
      tags: ["Recordings"],
      summary: "The recording's MP4 file",
      parameters: REC,
      responses: {
        "200": { description: "The file.", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
        "206": { description: "Part of the file (Range).", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
        "404": problem,
        "409": problem,
      },
    }),
  },
  "/api/v1/server": {
    get: op("viewer", {
      operationId: "server",
      tags: ["Server"],
      summary: "LiveKit and TURN, what flows through them today, and how each person connects",
      responses: { "200": ok(ref("Server")) },
    }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Server"],
      summary: "LiveKit, its webhooks and Egress, Identity's groups and TURN",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/settings": {
    get: op("viewer", {
      operationId: "settings",
      tags: ["Server"],
      summary: "meet.yaml as applied",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Meet",
    version,
    description:
      "Video meetings on LiveKit: meeting links, access tokens for the call, a lobby for guests, recordings by Egress where meet.yaml allows them, and the media server's health. Members (the user role) start, join and record their own meetings; viewers see every meeting and the server; editors' tokens let Calendar and Chat make meetings for someone; admins also stop recordings, delete any, and manage members and tokens.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
