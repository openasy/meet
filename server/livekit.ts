// LiveKit, the media server: access tokens for the browsers, its server API (Twirp, JSON over HTTP) for rooms,
// participants and Egress recordings, and the webhooks it sends. Meet never carries media itself.
//
// Tokens are JWTs signed with HS256 and the API secret, as LiveKit's own SDKs make them
// (https://docs.livekit.io/home/get-started/authentication/). The API answers in protobuf's JSON form: field names in
// snake_case or camelCase and 64-bit numbers as strings, so every read here takes both.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A JWT signed with HS256. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** The claims of a JWT signed with HS256 by this secret, or null when it is not one, is signed otherwise or has expired. */
export function verifyJwt(token: string, secret: string, now = Date.now()): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const h = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: string };
    if (h.alg !== "HS256") return null;
    const want = createHmac("sha256", secret).update(`${head}.${body}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const s = Math.floor(now / 1000);
    if (typeof claims.exp === "number" && claims.exp < s - 30) return null;
    if (typeof claims.nbf === "number" && claims.nbf > s + 30) return null;
    return claims;
  } catch {
    return null;
  }
}

/** What a participant may do in a room: LiveKit's VideoGrant, in its JSON names. */
export interface VideoGrant {
  roomJoin?: boolean;
  room?: string;
  roomCreate?: boolean;
  roomList?: boolean;
  roomAdmin?: boolean;
  roomRecord?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: Array<"camera" | "microphone" | "screen_share" | "screen_share_audio">;
  canUpdateOwnMetadata?: boolean;
  hidden?: boolean;
}

export interface TokenOptions {
  apiKey: string;
  apiSecret: string;
  identity?: string;
  name?: string;
  metadata?: string;
  attributes?: Record<string, string>;
  video: VideoGrant;
  ttlSeconds?: number;
  now?: number;
}

/** An access token, for a browser to join a room or for Meet to call the API. */
export function accessToken(o: TokenOptions): string {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  return signJwt(
    {
      iss: o.apiKey,
      ...(o.identity && { sub: o.identity }),
      ...(o.name && { name: o.name }),
      ...(o.metadata && { metadata: o.metadata }),
      ...(o.attributes && { attributes: o.attributes }),
      video: o.video,
      nbf: now,
      exp: now + (o.ttlSeconds ?? 600),
      jti: randomUUID(),
    },
    o.apiSecret,
  );
}

export class LiveKitError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "unavailable") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Reads a field in either of protobuf's JSON spellings. */
export function field<T = unknown>(o: unknown, snake: string): T | undefined {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return (r[snake] ?? r[camel]) as T | undefined;
}
const int = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0);

export interface LkRoom {
  sid: string;
  name: string;
  participants: number;
  createdAt: number;
  recording: boolean;
}

export interface LkParticipant {
  sid: string;
  identity: string;
  name: string;
  metadata: string;
  /** ms since the epoch. */
  joinedAt: number;
  state: string;
}

export type EgressState = "starting" | "active" | "ending" | "complete" | "failed" | "aborted" | "limit_reached";

export interface LkEgress {
  egressId: string;
  roomName: string;
  state: EgressState;
  /** ms since the epoch, 0 when not known. */
  startedAt: number;
  endedAt: number;
  error: string | null;
  file: { filename: string; size: number; durationMs: number } | null;
}

export function readRoom(r: unknown): LkRoom {
  return {
    sid: String(field(r, "sid") ?? ""),
    name: String(field(r, "name") ?? ""),
    participants: int(field(r, "num_participants")),
    createdAt: int(field(r, "creation_time")) * 1000,
    recording: field(r, "active_recording") === true,
  };
}

export function readParticipant(p: unknown): LkParticipant {
  const state = field(p, "state");
  return {
    sid: String(field(p, "sid") ?? ""),
    identity: String(field(p, "identity") ?? ""),
    name: String(field(p, "name") ?? ""),
    metadata: String(field(p, "metadata") ?? ""),
    joinedAt: int(field(p, "joined_at")) * 1000,
    state: typeof state === "number" ? (["JOINING", "JOINED", "ACTIVE", "DISCONNECTED"][state] ?? "ACTIVE") : String(state ?? "ACTIVE"),
  };
}

const EGRESS_STATES = ["starting", "active", "ending", "complete", "failed", "aborted", "limit_reached"] as const;

export function readEgress(e: unknown): LkEgress {
  const status = field(e, "status");
  const name =
    typeof status === "number"
      ? (EGRESS_STATES[status] ?? "starting")
      : String(status ?? "EGRESS_STARTING")
          .replace(/^EGRESS_/, "")
          .toLowerCase();
  const files = (field<unknown[]>(e, "file_results") ?? []).concat(field(e, "file") ? [field(e, "file")] : []);
  const f = files[0];
  const err = field<string>(e, "error");
  return {
    egressId: String(field(e, "egress_id") ?? ""),
    roomName: String(field(e, "room_name") ?? ""),
    state: (EGRESS_STATES as readonly string[]).includes(name) ? (name as EgressState) : "starting",
    // Egress gives times in nanoseconds.
    startedAt: Math.floor(int(field(e, "started_at")) / 1e6),
    endedAt: Math.floor(int(field(e, "ended_at")) / 1e6),
    error: err ? String(err) : null,
    file: f ? { filename: String(field(f, "filename") ?? ""), size: int(field(f, "size")), durationMs: Math.floor(int(field(f, "duration")) / 1e6) } : null,
  };
}

export interface LiveKitOptions {
  url: string;
  apiKey: string;
  apiSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** LiveKit's server API: RoomService and Egress over Twirp. Every call signs a short token with only the grant it needs. */
export function createLiveKit(o: LiveKitOptions) {
  const f = o.fetch ?? fetch;
  const base = o.url.replace(/\/$/, "");
  async function twirp(service: string, method: string, body: unknown, video: VideoGrant): Promise<unknown> {
    if (!o.apiSecret) throw new LiveKitError("No API secret for LiveKit: set the environment variable livekit.api_secret names.", 0, "no-secret");
    const token = accessToken({ apiKey: o.apiKey, apiSecret: o.apiSecret, video, ttlSeconds: 60 });
    let res: Response;
    try {
      res = await f(`${base}/twirp/livekit.${service}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new LiveKitError(`LiveKit at ${base} cannot be reached: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON: something else answered at that address.
    }
    if (!res.ok) {
      const code = String(field(data, "code") ?? "unknown");
      const msg = String(field(data, "msg") ?? text.slice(0, 200));
      throw new LiveKitError(`LiveKit answered ${res.status} to ${method}: ${msg}`, res.status, code);
    }
    if (data === null) throw new LiveKitError(`LiveKit at ${base} did not answer in JSON to ${method}.`);
    return data;
  }
  const rooms = (body: unknown, method: string, video: VideoGrant) => twirp("RoomService", method, body, video);
  return {
    url: base,
    async listRooms(names?: string[]): Promise<LkRoom[]> {
      const r = await rooms({ ...(names && { names }) }, "ListRooms", { roomList: true });
      return (field<unknown[]>(r, "rooms") ?? []).map(readRoom);
    },
    async createRoom(name: string, opts: { maxParticipants: number; emptyTimeout: number; departureTimeout: number; metadata?: string }): Promise<LkRoom> {
      return readRoom(await rooms({ name, ...opts }, "CreateRoom", { roomCreate: true }));
    },
    async deleteRoom(name: string): Promise<void> {
      await rooms({ room: name }, "DeleteRoom", { roomCreate: true });
    },
    async listParticipants(room: string): Promise<LkParticipant[]> {
      const r = await rooms({ room }, "ListParticipants", { roomAdmin: true, room });
      return (field<unknown[]>(r, "participants") ?? []).map(readParticipant);
    },
    async removeParticipant(room: string, identity: string): Promise<void> {
      await rooms({ room, identity }, "RemoveParticipant", { roomAdmin: true, room });
    },
    async startRecording(room: string, filepath: string): Promise<LkEgress> {
      const r = await twirp(
        "Egress",
        "StartRoomCompositeEgress",
        { roomName: room, layout: "speaker", fileOutputs: [{ fileType: "MP4", filepath }] },
        { roomRecord: true },
      );
      return readEgress(r);
    },
    async stopRecording(egressId: string): Promise<LkEgress> {
      return readEgress(await twirp("Egress", "StopEgress", { egressId }, { roomRecord: true }));
    },
    async listEgress(room?: string): Promise<LkEgress[]> {
      const r = await twirp("Egress", "ListEgress", room ? { roomName: room } : {}, { roomRecord: true });
      return (field<unknown[]>(r, "items") ?? []).map(readEgress);
    },
  };
}
export type LiveKit = ReturnType<typeof createLiveKit>;

export interface WebhookEvent {
  event: string;
  id: string;
  room: LkRoom | null;
  participant: LkParticipant | null;
  egress: LkEgress | null;
  /** ms since the epoch. */
  createdAt: number;
}

/**
 * A webhook from LiveKit, when it is signed by the API key and secret and its body is the one signed: the Authorization
 * header is a JWT whose sha256 claim is the body's hash. null when it is not.
 */
export function readWebhook(body: string, authorization: string | undefined, apiKey: string, apiSecret: string, now = Date.now()): WebhookEvent | null {
  if (!authorization || !apiSecret) return null;
  const claims = verifyJwt(authorization.replace(/^Bearer\s+/i, ""), apiSecret, now);
  if (!claims || claims.iss !== apiKey) return null;
  const hash = createHash("sha256").update(body).digest("base64");
  if (typeof claims.sha256 !== "string" || claims.sha256.replace(/=+$/, "") !== hash.replace(/=+$/, "")) return null;
  let e: unknown;
  try {
    e = JSON.parse(body);
  } catch {
    return null;
  }
  const room = field(e, "room");
  const participant = field(e, "participant");
  const egress = field(e, "egress_info");
  return {
    event: String(field(e, "event") ?? ""),
    id: String(field(e, "id") ?? ""),
    room: room ? readRoom(room) : null,
    participant: participant ? readParticipant(participant) : null,
    egress: egress ? readEgress(egress) : null,
    createdAt: int(field(e, "created_at")) * 1000,
  };
}

/** The Authorization header LiveKit sends with a webhook, for tests and the fake. */
export function signWebhook(body: string, apiKey: string, apiSecret: string, now = Date.now()): string {
  const s = Math.floor(now / 1000);
  return signJwt({ iss: apiKey, nbf: s, exp: s + 300, sha256: createHash("sha256").update(body).digest("base64"), video: {} }, apiSecret);
}

/** The few numbers the Server page shows from LiveKit's Prometheus endpoint: Go's standard process metrics. */
export function readProcessMetrics(text: string): { cpuSeconds: number | null; memoryBytes: number | null; startedAt: number | null; cores: number | null } {
  const value = (name: string) => {
    const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)\\s*$`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const started = value("process_start_time_seconds");
  return {
    cpuSeconds: value("process_cpu_seconds_total"),
    memoryBytes: value("process_resident_memory_bytes"),
    startedAt: started === null ? null : started * 1000,
    cores: value("go_sched_gomaxprocs_threads"),
  };
}
