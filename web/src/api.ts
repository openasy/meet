// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

export type Source = "calendar" | "chat" | "hand" | "room";
export type MeetingStatus = "live" | "upcoming" | "ended";
export type MediaPath = "udp" | "tcp" | "turn-udp" | "turn-tcp" | "turn-tls" | "unknown";

export interface Meeting {
  id: string;
  url: string;
  title: string;
  source: Source;
  channel: string | null;
  reference: string | null;
  organizer: { email: string; name: string };
  startsAt: string | null;
  endsAt: string | null;
  at: string;
  invited: number | null;
  status: MeetingStatus;
  joined: number;
  guests: number;
  minutes: number | null;
  inCall: { people: number; guests: number };
  startedAt: string | null;
  lobby: number;
  allowRecording: boolean;
  recording: boolean;
  recorded: boolean;
  admitted: { by: string; at: string } | null;
  media: { direct: number; relayed: number };
  createdAt: string;
  you: { organizer: boolean; invited: boolean; canManage: boolean };
}

export interface MeetingList {
  day: string;
  timeZone: string;
  meetings: Meeting[];
  totals: {
    meetings: number;
    live: number;
    upcoming: number;
    ended: number;
    joined: number;
    guests: number;
    averageMinutes: number | null;
    recorded: number;
    firstRecorded: { title: string; group: string | null } | null;
  };
}

export type RecordingPolicy =
  | { allowed: true; group: string; groupName: string; keepDays: number }
  | { allowed: false; reason: "off" | "never" | "not-in-group"; group: string | null; groupName: string | null };

export interface Me {
  member: { id: string; name: string; email: string | null; role: string };
  organization: string | null;
  groups: Array<{ id: string; name: string }>;
  recording: RecordingPolicy;
  room: Meeting | null;
  guests: boolean;
  limits: { people: number; video: "360p" | "540p" | "720p" | "1080p" };
  media: { url: string; host: string | null };
}

export interface Access {
  url: string;
  identity: string;
  token: string;
}

export interface JoinInfo {
  id: string;
  title: string;
  organization: string | null;
  organizer: string;
  guests: boolean;
  live: boolean;
  recording: boolean;
  allowRecording: boolean;
}

export type LobbyState = "waiting" | "admitted" | "denied" | "expired" | "left";

export interface LobbyStatus {
  id: string;
  state: LobbyState;
  meeting: JoinInfo;
  join: Access | null;
}

export interface Waiting {
  id: string;
  name: string;
  email: string | null;
  invited: boolean;
  since: string;
}

export interface Recording {
  id: string;
  meetingId: string | null;
  title: string;
  state: "recording" | "saving" | "ready" | "failed";
  startedBy: { email: string; name: string };
  group: { id: string; name: string; keepDays: number };
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  size: number;
  file: string;
  people: string[];
  guests: number;
  deleteOn: string | null;
  error: string | null;
  canDelete: boolean;
}

export interface RecordingList {
  recordings: Recording[];
  totals: {
    kept: number;
    bytes: number;
    capacity: number | null;
    meetingsLast30Days: number;
    nextDeletion: { on: string; title: string; keepDays: number } | null;
  };
  policy: { on: boolean; groups: Array<{ id: string; name: string; keepDays: number }>; never: Array<{ id: string; name: string }>; yaml: string };
}

export interface LinkState {
  ok: boolean | null;
  at: string | null;
  error: string | null;
}

export interface Connection {
  identity: string;
  name: string;
  guest: boolean;
  meetingId: string;
  meeting: string;
  path: MediaPath;
  rttMs: number | null;
  lossPercent: number | null;
  sending: string;
  browser: string;
  at: string;
}

export interface ServerState {
  livekit: LinkState & {
    url: string;
    publicUrl: string;
    ms: number | null;
    rooms: number;
    mediaPorts: string | null;
    cpuPercent: number | null;
    cores: number | null;
    memoryBytes: number | null;
    startedAt: string | null;
    metrics: LinkState | null;
  };
  limits: { meetings: number; people: number; video: string; bandwidth: number | null };
  live: { meetings: number; people: number; lobby: number };
  bandwidth: { nowMbps: number; capacityMbps: number | null; samples: Array<{ at: string; totalMbps: number; relayedMbps: number }> };
  turn: Array<{ host: string; port: number; transport: "udp" | "tcp" | "tls"; ok: boolean | null; ms: number | null; error: string | null; at: string | null }>;
  connections: Connection[];
}

export interface Integrations {
  livekit: LinkState & { url: string; publicUrl: string; secret: boolean; ms: number | null; rooms: number };
  webhooks: LinkState & { url: string; count: number; last: string | null };
  egress: LinkState & { on: boolean; storage: string | null };
  metrics: LinkState & { url: string | null };
  identity: { peopleWithGroups: number; fileGroups: number };
  turn: { listeners: number; reachable: number };
  api: { meetings: string };
}

export interface Settings {
  file: { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;
  yaml: string;
  config: {
    timeZone: string;
    organization: string | null;
    livekit: { url: string; publicUrl: string; apiKey: string; apiSecret: string; metricsUrl: string | null; mediaPorts: string | null };
    limits: { meetings: number; people: number; video: string; bandwidth: number | null };
    lobby: { guests: boolean; waitMinutes: number };
    groups: Record<string, { name: string; members: string[] }>;
    recording: { allowedFor: Array<{ group: string; keepDays: number }>; neverFor: string[]; storage: string } | null;
    turn: Array<{ host: string; port: number; transport: string }>;
  };
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401 && !path.startsWith("/api/v1/lobby")) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, res.status, problem.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
