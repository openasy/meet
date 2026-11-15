// Meet's own part, next to LiveKit: meetings and their links, who may join and how (members straight in, everyone else
// through the lobby), the access tokens browsers join with, who was in each call, recordings by Egress where the file
// allows them, and what the Server page shows. LiveKit carries every call; this keeps only what the pages list.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { join as joinPath, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atLeast, type Role } from "@openasy/auth";
import { parse, stringify } from "yaml";
import { parseConfig, type Config, type ConfigFileState } from "./config.ts";
import { accessToken, createLiveKit, LiveKitError, readProcessMetrics, type LiveKit, type LkEgress, type LkParticipant, type WebhookEvent } from "./livekit.ts";
import { log } from "./log.ts";
import { checkTurn, type TurnCheck } from "./turn.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "limit-reached"
  | "guests-not-allowed"
  | "rate-limited"
  | "media-server-unavailable"
  | "payload-too-large"
  | "internal-error";

export class MeetError extends Error {
  status: number;
  code: ProblemCode;
  constructor(status: number, code: ProblemCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Who calls: a signed-in member (with their email), or an API token (no email). */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  email: string | null;
}

export type Source = "calendar" | "chat" | "hand" | "room";
type Status = "live" | "upcoming" | "ended";
export type MediaPath = "udp" | "tcp" | "turn-udp" | "turn-tcp" | "turn-tls" | "unknown";
const PATHS: MediaPath[] = ["udp", "tcp", "turn-udp", "turn-tcp", "turn-tls", "unknown"];

/** Page names and paths that a meeting link cannot take. */
const RESERVED = new Set([
  "meetings",
  "meeting",
  "recordings",
  "server",
  "integrations",
  "settings",
  "account",
  "members",
  "signin",
  "tokens",
  "api",
  "assets",
  "join",
  "lobby",
  "healthz",
  "readyz",
  "metrics",
  "favicon",
]);
const CODE_LETTERS = "abcdefghijkmnpqrstuvwxyz23456789";
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_WAITING = 20;

interface MeetingRow {
  id: string;
  title: string;
  source: Source;
  channel: string | null;
  reference: string | null;
  organizer_email: string;
  organizer_name: string;
  starts_at: string | null;
  ends_at: string | null;
  invited: string | null;
  allow_recording: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CallRow {
  id: number;
  meeting_id: string;
  room_sid: string | null;
  started_at: string;
  ended_at: string | null;
}

interface LobbyRow {
  id: string;
  meeting_id: string;
  ticket_hash: string;
  name: string;
  email: string | null;
  state: "waiting" | "admitted" | "denied" | "expired" | "left";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

interface RecordingRow {
  id: string;
  meeting_id: string | null;
  egress_id: string | null;
  title: string;
  started_by_email: string;
  started_by_name: string;
  group_id: string;
  group_name: string;
  keep_days: number;
  state: "recording" | "saving" | "ready" | "failed";
  file: string;
  size: number;
  duration_s: number;
  people: string;
  guests: number;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  delete_on: string | null;
}

interface Person {
  identity: string;
  kind: "member" | "guest";
  name: string | null;
}

export interface ConnectionReport {
  identity: string;
  name: string;
  guest: boolean;
  meetingId: string;
  path: MediaPath;
  rttMs: number | null;
  lossPercent: number | null;
  sendKbps: number;
  receiveKbps: number;
  sending: string;
  browser: string;
  at: number;
}

export interface LinkState {
  ok: boolean | null;
  at: string | null;
  error: string | null;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const randomCode = () =>
  Array.from({ length: 3 }, () =>
    Array.from(randomBytes(3))
      .map((b) => CODE_LETTERS[b % CODE_LETTERS.length])
      .join(""),
  ).join("-");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The difference between a time zone's wall clock and UTC at this moment, in ms. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(at / 1000) * 1000;
}

/** A day, YYYY-MM-DD, in the time zone. */
export function dayOf(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** When a day begins and ends in the time zone, as ms since the epoch. */
export function dayRange(day: string, timeZone: string): { from: number; to: number } {
  const start = (d: string) => {
    const guess = Date.parse(`${d}T00:00:00Z`);
    const first = guess - zoneOffset(guess, timeZone);
    return guess - zoneOffset(first, timeZone);
  };
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 24 * 3600_000).toISOString().slice(0, 10);
  return { from: start(day), to: start(next) };
}

/** A person's own room's link: their name in small letters, joined by dashes. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ı/g, "i")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "room"
  );
}

/** A meeting's id from a link or a code: https://meet.example.com/abc-def-ghi, meet.example.com/abc-def-ghi or abc-def-ghi. */
export function codeOf(link: string): string | null {
  const s = link.trim().replace(/^[a-z]+:\/\//i, "");
  const last = s.split(/[?#]/)[0]!.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  return ID.test(last) && !RESERVED.has(last) ? last : null;
}

function text(v: unknown, at: string, max: number, optional = false): string | null {
  if ((v === undefined || v === null || v === "") && optional) return null;
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new MeetError(422, "invalid-body", `${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function time(v: unknown, at: string): string | null {
  if (v === undefined || v === null) return null;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new MeetError(422, "invalid-body", `${at} is a date and time, such as 2026-11-05T14:00:00Z.`);
  return new Date(t).toISOString();
}

function emails(v: unknown, at: string): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 1000) throw new MeetError(422, "invalid-body", `${at} is a list of email addresses.`);
  return [
    ...new Set(
      v.map((e, i) => {
        const s = typeof e === "string" ? e.trim().toLowerCase() : "";
        if (!EMAIL.test(s)) throw new MeetError(422, "invalid-body", `${at}[${i}] is an email address.`);
        return s;
      }),
    ),
  ];
}

export interface MeetOptions {
  publicUrl: string;
  /** Where the API secret is read from, by the name the file gives. */
  env?: Record<string, string | undefined>;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
  /** For tests: how LiveKit is reached. */
  liveKit?: (o: { url: string; apiKey: string; apiSecret: string }) => LiveKit;
  /** For tests: how TURN listeners are checked. */
  turnCheck?: typeof checkTurn;
  /** For tests: how LiveKit's metrics are read. */
  fetch?: typeof fetch;
}

export function createMeet(db: DatabaseSync, opts: MeetOptions) {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? Date.now;
  const nowIso = () => new Date(clock()).toISOString();
  const publicUrl = opts.publicUrl.replace(/\/$/, "");
  const makeLiveKit = opts.liveKit ?? createLiveKit;
  const turnCheck = opts.turnCheck ?? checkTurn;
  const f = opts.fetch ?? fetch;

  let config: Config = parseConfig("").config;
  let yaml = "";
  let lk: LiveKit = makeLiveKit({ url: config.livekit.url, apiKey: config.livekit.apiKey, apiSecret: "" });
  let secret = "";
  const links = {
    livekit: { ok: null, at: null, error: null, ms: null as number | null, rooms: 0 } as LinkState & { ms: number | null; rooms: number },
    webhooks: { ok: null, at: null, error: null, count: 0, last: null as string | null } as LinkState & { count: number; last: string | null },
    egress: { ok: null, at: null, error: null } as LinkState,
    metrics: { ok: null, at: null, error: null } as LinkState,
  };
  let process_: {
    cpuPercent: number | null;
    memoryBytes: number | null;
    startedAt: number | null;
    cores: number | null;
    last: { cpu: number; at: number } | null;
  } = {
    cpuPercent: null,
    memoryBytes: null,
    startedAt: null,
    cores: null,
    last: null,
  };
  let turn: TurnCheck[] = [];
  const reports = new Map<string, ConnectionReport>();
  const counters = { tokens: new Map<string, number>(), lobby: new Map<string, number>(), recordings: new Map<string, number>(), webhooks: 0 };
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const q = {
    meeting: db.prepare("SELECT * FROM meetings WHERE id = ?"),
    openCall: db.prepare("SELECT * FROM calls WHERE meeting_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"),
    lastCall: db.prepare("SELECT * FROM calls WHERE meeting_id = ? ORDER BY id DESC LIMIT 1"),
    openCalls: db.prepare("SELECT * FROM calls WHERE ended_at IS NULL"),
    present: db.prepare("SELECT * FROM attendance WHERE call_id = ? AND left_at IS NULL"),
    user: db.prepare("SELECT id, email, name, role FROM auth_users WHERE id = ?"),
    userByEmail: db.prepare("SELECT id, email, name, role FROM auth_users WHERE lower(email) = ?"),
    lobbyByTicket: db.prepare("SELECT * FROM lobby WHERE ticket_hash = ?"),
    lobbyEntry: db.prepare("SELECT * FROM lobby WHERE id = ? AND meeting_id = ?"),
    waiting: db.prepare("SELECT * FROM lobby WHERE meeting_id = ? AND state = 'waiting' ORDER BY created_at"),
    activeRecording: db.prepare("SELECT * FROM recordings WHERE meeting_id = ? AND state = 'recording' ORDER BY started_at DESC LIMIT 1"),
    recording: db.prepare("SELECT * FROM recordings WHERE id = ?"),
  };

  // ------------------------------------------------------------------ settings

  function setConfig(next: Config, raw: string) {
    const s = env[next.livekit.apiSecret] ?? "";
    if (next.livekit.url !== config.livekit.url || next.livekit.apiKey !== config.livekit.apiKey || s !== secret || !yaml)
      lk = makeLiveKit({ url: next.livekit.url, apiKey: next.livekit.apiKey, apiSecret: s });
    secret = s;
    config = next;
    yaml = raw;
    if (!s) log("warn", "no API secret for LiveKit: meetings cannot be joined until it is set", { variable: next.livekit.apiSecret });
  }

  /** The origins the pages connect to LiveKit at, for the CSP: wss:// for signalling and https:// for its checks. */
  function mediaOrigins(): string[] {
    const u = URL.parse(config.livekit.publicUrl);
    if (!u) return [];
    const http = u.protocol === "wss:" ? "https:" : "http:";
    return [u.origin.replace(/^ws(s?):/, u.protocol), `${http}//${u.host}`];
  }

  // ------------------------------------------------------------------ people and groups

  /** The groups a person is in: the file's, by email, and their identity provider's at the last sign-in. */
  function groupsOf(userId: string | null, email: string | null): string[] {
    const out = new Set<string>();
    if (email) for (const [id, g] of Object.entries(config.groups)) if (g.members.includes(email.toLowerCase())) out.add(id);
    if (userId) {
      const row = db.prepare("SELECT groups FROM person_groups WHERE user_id = ?").get(userId) as { groups: string } | undefined;
      for (const g of row ? (JSON.parse(row.groups) as string[]) : []) out.add(g.toLowerCase());
    }
    return [...out];
  }

  function noteGroups(userId: string, groups: string[]) {
    db.prepare(
      "INSERT INTO person_groups (user_id, groups, at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET groups = excluded.groups, at = excluded.at",
    ).run(userId, JSON.stringify(groups.map((g) => String(g).toLowerCase()).slice(0, 200)), nowIso());
  }

  const groupName = (id: string) => config.groups[id]?.name ?? id;

  type Policy =
    | { allowed: true; group: string; groupName: string; keepDays: number }
    | { allowed: false; reason: "off" | "never" | "not-in-group"; group: string | null; groupName: string | null };

  /** Whether a person may record their meetings, and for which group: the file's recording rules. */
  function policyFor(userId: string | null, email: string | null): Policy {
    const r = config.recording;
    if (!r) return { allowed: false, reason: "off", group: null, groupName: null };
    const groups = groupsOf(userId, email);
    const never = r.neverFor.find((g) => groups.includes(g));
    if (never) return { allowed: false, reason: "never", group: never, groupName: groupName(never) };
    const rule = r.allowedFor.find((a) => groups.includes(a.group));
    if (!rule) return { allowed: false, reason: "not-in-group", group: null, groupName: null };
    return { allowed: true, group: rule.group, groupName: groupName(rule.group), keepDays: rule.keepDays };
  }

  const organizerPolicy = (m: MeetingRow) => {
    const u = q.userByEmail.get(m.organizer_email) as { id: string } | undefined;
    return policyFor(u?.id ?? null, m.organizer_email);
  };

  // ------------------------------------------------------------------ meetings

  function getRow(id: string): MeetingRow {
    const m = q.meeting.get(id) as MeetingRow | undefined;
    if (!m) throw new MeetError(404, "not-found", "There is no meeting at this link.");
    return m;
  }

  const invitedOf = (m: MeetingRow): string[] | null => (m.invited ? (JSON.parse(m.invited) as string[]) : null);

  function attended(meetingId: string, email: string): boolean {
    return !!db
      .prepare("SELECT 1 FROM attendance a JOIN calls c ON c.id = a.call_id WHERE c.meeting_id = ? AND a.email = ? LIMIT 1")
      .get(meetingId, email.toLowerCase());
  }

  /** Viewers see every meeting; members see the ones they organise, are invited to or joined. */
  function visible(m: MeetingRow, who: Actor): boolean {
    if (atLeast(who.role, "viewer")) return true;
    if (!who.email) return false;
    const e = who.email.toLowerCase();
    return m.organizer_email === e || !!invitedOf(m)?.includes(e) || attended(m.id, e);
  }

  const canManage = (m: MeetingRow, who: Actor) => atLeast(who.role, "editor") || (!!who.email && who.email.toLowerCase() === m.organizer_email);

  function callStats(meetingId: string, from?: number, to?: number) {
    const calls = (db.prepare("SELECT * FROM calls WHERE meeting_id = ? ORDER BY id").all(meetingId) as unknown as CallRow[]).filter((c) => {
      const t = Date.parse(c.started_at);
      return (from === undefined || t >= from) && (to === undefined || t < to);
    });
    const ids = calls.map((c) => c.id);
    let joined = 0;
    let guests = 0;
    if (ids.length) {
      const r = db
        .prepare(
          `SELECT COUNT(DISTINCT identity) AS joined, COUNT(DISTINCT CASE WHEN kind = 'guest' THEN identity END) AS guests FROM attendance WHERE call_id IN (${ids.map(() => "?").join(",")})`,
        )
        .get(...ids) as { joined: number; guests: number };
      joined = r.joined;
      guests = r.guests;
    }
    const ms = calls.reduce((n, c) => n + ((c.ended_at ? Date.parse(c.ended_at) : clock()) - Date.parse(c.started_at)), 0);
    return { calls, joined, guests, minutes: calls.length ? Math.max(0, Math.round(ms / 60_000)) : null };
  }

  function toMeeting(m: MeetingRow, who: Actor | null, range?: { from: number; to: number }) {
    const open = q.openCall.get(m.id) as CallRow | undefined;
    const s = range ? callStats(m.id, range.from, range.to) : callStats(m.id, open ? Date.parse(open.started_at) : undefined);
    const last = s.calls.at(-1);
    const live = !!open;
    const status: Status = live
      ? "live"
      : s.calls.length
        ? "ended"
        : m.starts_at && Date.parse(m.starts_at) > clock()
          ? "upcoming"
          : m.starts_at
            ? "ended"
            : "upcoming";
    const present = open ? (q.present.all(open.id) as unknown as Array<{ kind: string }>) : [];
    const invited = invitedOf(m);
    const e = who?.email?.toLowerCase() ?? null;
    const recorded = db.prepare("SELECT 1 FROM recordings WHERE meeting_id = ? LIMIT 1").get(m.id);
    const admitted = db
      .prepare("SELECT decided_by, decided_at FROM lobby WHERE meeting_id = ? AND state = 'admitted' ORDER BY decided_at DESC LIMIT 1")
      .get(m.id) as { decided_by: string; decided_at: string } | undefined;
    const media = [...reports.values()].filter((r) => r.meetingId === m.id && clock() - r.at < 90_000);
    return {
      id: m.id,
      url: `${publicUrl}/${m.id}`,
      title: m.title,
      source: m.source,
      channel: m.channel,
      reference: m.reference,
      organizer: { email: m.organizer_email, name: m.organizer_name },
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      /** When it started or starts: the first call of the range, else the planned start, else when the link was made. */
      at: s.calls[0]?.started_at ?? m.starts_at ?? m.created_at,
      invited: invited ? invited.length : null,
      status,
      joined: s.joined,
      guests: s.guests,
      minutes: s.minutes,
      inCall: { people: present.length, guests: present.filter((p) => p.kind === "guest").length },
      startedAt: open?.started_at ?? last?.started_at ?? null,
      lobby: (q.waiting.all(m.id) as unknown[]).length,
      allowRecording: m.allow_recording === 1,
      recording: !!q.activeRecording.get(m.id),
      recorded: !!recorded,
      admitted: admitted ? { by: admitted.decided_by, at: admitted.decided_at } : null,
      media: { direct: media.filter((r) => !r.path.startsWith("turn")).length, relayed: media.filter((r) => r.path.startsWith("turn")).length },
      createdAt: m.created_at,
      you: {
        organizer: !!e && e === m.organizer_email,
        invited: !!e && !!invited?.includes(e),
        canManage: who ? canManage(m, who) : false,
      },
    };
  }
  type Meeting = ReturnType<typeof toMeeting>;

  function newId(): string {
    for (;;) {
      const id = randomCode();
      if (!q.meeting.get(id)) return id;
    }
  }

  function organizerFrom(who: Actor, v: unknown): { email: string; name: string } {
    if (v === undefined || v === null) {
      if (!who.email) throw new MeetError(422, "invalid-body", "An API token makes a meeting for someone: give organizer with their email.");
      return { email: who.email.toLowerCase(), name: who.name };
    }
    if (!atLeast(who.role, "editor"))
      throw new MeetError(403, "forbidden", "Only editors, such as Calendar's and Chat's tokens, make meetings for someone else.");
    if (!isObj(v)) throw new MeetError(422, "invalid-body", "organizer is a map with email and name.");
    const email = typeof v.email === "string" ? v.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new MeetError(422, "invalid-body", "organizer.email is an email address.");
    const member = q.userByEmail.get(email) as { name: string } | undefined;
    return { email, name: text(v.name, "organizer.name", 120, true) ?? member?.name ?? email };
  }

  function create(who: Actor, body: unknown): { meeting: Meeting; created: boolean } {
    if (!isObj(body)) throw new MeetError(422, "invalid-body", "The body is a JSON object.");
    const organizer = organizerFrom(who, body.organizer);
    const source = (body.source ?? "hand") as Source;
    if (!["calendar", "chat", "hand"].includes(source)) throw new MeetError(422, "invalid-body", "source is calendar, chat or hand.");
    const reference = text(body.reference, "reference", 255, true);
    if (reference) {
      const found = db.prepare("SELECT * FROM meetings WHERE source = ? AND reference = ?").get(source, reference) as MeetingRow | undefined;
      if (found) return { meeting: toMeeting(found, who), created: false };
    }
    const channel = text(body.channel, "channel", 80, true);
    const title = text(body.title, "title", 200, true) ?? organizer.name;
    const startsAt = time(body.startsAt, "startsAt");
    const endsAt = time(body.endsAt, "endsAt");
    if (startsAt && endsAt && endsAt < startsAt) throw new MeetError(422, "invalid-body", "endsAt is after startsAt.");
    const invited = emails(body.invited, "invited");
    if (body.allowRecording !== undefined && typeof body.allowRecording !== "boolean")
      throw new MeetError(422, "invalid-body", "allowRecording is true or false.");
    const allow = body.allowRecording === true;
    if (allow) {
      const u = q.userByEmail.get(organizer.email) as { id: string } | undefined;
      const p = policyFor(u?.id ?? null, organizer.email);
      if (!p.allowed) throw new MeetError(403, "forbidden", "meet.yaml does not allow this organiser to record.");
    }
    const id = newId();
    const at = nowIso();
    db.prepare(
      `INSERT INTO meetings (id, title, source, channel, reference, organizer_email, organizer_name, starts_at, ends_at, invited, allow_recording, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      title,
      source,
      channel,
      reference,
      organizer.email,
      organizer.name,
      startsAt ?? (source === "hand" || source === "chat" ? at : null),
      endsAt,
      invited ? JSON.stringify(invited) : null,
      allow ? 1 : 0,
      who.name,
      at,
      at,
    );
    log("info", "meeting made", { id, source, by: who.id });
    return { meeting: toMeeting(getRow(id), who), created: true };
  }

  function update(who: Actor, id: string, body: unknown): Meeting {
    const m = getRow(id);
    if (!visible(m, who) || !canManage(m, who)) throw new MeetError(403, "forbidden", "Only the organiser or an editor changes a meeting.");
    if (!isObj(body)) throw new MeetError(422, "invalid-body", "The body is a JSON object.");
    const next = { ...m };
    if (body.title !== undefined) next.title = text(body.title, "title", 200)!;
    if (body.startsAt !== undefined) next.starts_at = time(body.startsAt, "startsAt");
    if (body.endsAt !== undefined) next.ends_at = time(body.endsAt, "endsAt");
    if (body.invited !== undefined) next.invited = body.invited === null ? null : JSON.stringify(emails(body.invited, "invited"));
    if (next.starts_at && next.ends_at && next.ends_at < next.starts_at) throw new MeetError(422, "invalid-body", "endsAt is after startsAt.");
    if (body.allowRecording !== undefined) {
      if (typeof body.allowRecording !== "boolean") throw new MeetError(422, "invalid-body", "allowRecording is true or false.");
      if (body.allowRecording && !organizerPolicy(m).allowed) throw new MeetError(403, "forbidden", "meet.yaml does not allow this organiser to record.");
      next.allow_recording = body.allowRecording ? 1 : 0;
    }
    db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, invited = ?, allow_recording = ?, updated_at = ? WHERE id = ?").run(
      next.title,
      next.starts_at,
      next.ends_at,
      next.invited,
      next.allow_recording,
      nowIso(),
      id,
    );
    return toMeeting(getRow(id), who);
  }

  async function remove(who: Actor, id: string): Promise<void> {
    const m = getRow(id);
    if (!visible(m, who) || !canManage(m, who)) throw new MeetError(403, "forbidden", "Only the organiser or an editor deletes a meeting.");
    if (q.openCall.get(id)) {
      try {
        await lk.deleteRoom(id);
      } catch (err) {
        throw unavailable(err);
      }
    }
    db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    log("info", "meeting deleted", { id, by: who.id });
  }

  function get(who: Actor, id: string): Meeting {
    const m = getRow(id);
    if (!visible(m, who)) throw new MeetError(404, "not-found", "There is no meeting at this link that you can see.");
    return toMeeting(m, who);
  }

  /** The day's meetings: planned for it, or with a call that started in it. */
  function list(who: Actor, day?: string | null) {
    const d = day ?? dayOf(clock(), config.timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`))) throw new MeetError(422, "invalid-body", "day is YYYY-MM-DD.");
    const range = dayRange(d, config.timeZone);
    const from = new Date(range.from).toISOString();
    const to = new Date(range.to).toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM meetings m WHERE (m.starts_at >= ? AND m.starts_at < ?)
           OR EXISTS (SELECT 1 FROM calls c WHERE c.meeting_id = m.id AND c.started_at >= ? AND c.started_at < ?)
           OR EXISTS (SELECT 1 FROM calls c WHERE c.meeting_id = m.id AND c.ended_at IS NULL)`,
      )
      .all(from, to, from, to) as unknown as MeetingRow[];
    const meetings = rows
      .filter((m) => visible(m, who))
      .map((m) => toMeeting(m, who, range))
      .sort((a, b) => a.at.localeCompare(b.at));
    const ended = meetings.filter((m) => m.status === "ended" && m.minutes !== null);
    const done = meetings.filter((m) => m.status !== "upcoming");
    const recorded = meetings.filter((m) => m.recorded);
    const rec = recorded[0] && (db.prepare("SELECT group_name FROM recordings WHERE meeting_id = ? LIMIT 1").get(recorded[0].id) as { group_name: string });
    return {
      day: d,
      timeZone: config.timeZone,
      meetings,
      totals: {
        meetings: meetings.length,
        live: meetings.filter((m) => m.status === "live").length,
        upcoming: meetings.filter((m) => m.status === "upcoming").length,
        ended: meetings.filter((m) => m.status === "ended").length,
        joined: done.reduce((n, m) => n + m.joined, 0),
        guests: done.reduce((n, m) => n + m.guests, 0),
        averageMinutes: ended.length ? Math.round(ended.reduce((n, m) => n + (m.minutes ?? 0), 0) / ended.length) : null,
        recorded: recorded.length,
        firstRecorded: recorded[0] ? { title: recorded[0].title, group: rec ? rec.group_name : null } : null,
      },
    };
  }

  /** A person's own room: a link that stays theirs, made the first time they ask. */
  function personalRoom(who: Actor): Meeting | null {
    if (!who.email) return null;
    const e = who.email.toLowerCase();
    let m = db.prepare("SELECT * FROM meetings WHERE source = 'room' AND organizer_email = ?").get(e) as MeetingRow | undefined;
    if (!m) {
      const base = slug(who.name || e.split("@")[0]!);
      let id = RESERVED.has(base) || base.length < 2 ? `${base}-room` : base;
      for (let n = 2; q.meeting.get(id); n++) id = `${base}-${n}`;
      const at = nowIso();
      db.prepare(
        `INSERT INTO meetings (id, title, source, organizer_email, organizer_name, allow_recording, created_by, created_at, updated_at)
         VALUES (?, ?, 'room', ?, ?, 0, ?, ?, ?)`,
      ).run(id, who.name, e, who.name, who.name, at, at);
      m = getRow(id);
    }
    return toMeeting(m, who);
  }

  function me(who: Actor) {
    const userId = who.id.startsWith("token:") ? null : who.id;
    const p = policyFor(userId, who.email);
    return {
      member: { id: who.id, name: who.name, email: who.email, role: who.role },
      organization: config.organization,
      groups: groupsOf(userId, who.email).map((id) => ({ id, name: groupName(id) })),
      recording: p,
      room: personalRoom(who),
      guests: config.lobby.guests,
      limits: { people: config.limits.people, video: config.limits.video },
      media: { url: config.livekit.publicUrl, host: URL.parse(config.livekit.publicUrl)?.host ?? null },
    };
  }

  // ------------------------------------------------------------------ joining

  function unavailable(err: unknown): MeetError {
    if (err instanceof MeetError) return err;
    const e = err as LiveKitError;
    Object.assign(links.livekit, { ok: false, at: nowIso(), error: e.message });
    return new MeetError(503, "media-server-unavailable", e.message);
  }

  function liveCount(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM calls WHERE ended_at IS NULL").get() as { n: number }).n;
  }

  /** Opens the meeting's room in LiveKit, within the file's limits, and the call that goes with it. */
  async function openRoom(m: MeetingRow): Promise<void> {
    if (!q.openCall.get(m.id) && liveCount() >= config.limits.meetings)
      throw new MeetError(409, "limit-reached", `${config.limits.meetings} meetings are live, as many as meet.yaml allows at once. Try again when one ends.`);
    try {
      const room = await lk.createRoom(m.id, {
        maxParticipants: config.limits.people,
        emptyTimeout: 300,
        departureTimeout: 20,
        metadata: JSON.stringify({ title: m.title }),
      });
      ensureCall(m.id, room.sid || null);
    } catch (err) {
      throw unavailable(err);
    }
  }

  function grant(room: string) {
    return {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canPublishSources: ["camera", "microphone", "screen_share", "screen_share_audio"] as Array<
        "camera" | "microphone" | "screen_share" | "screen_share_audio"
      >,
    };
  }

  function mint(room: string, identity: string, name: string, kind: "member" | "guest", extra: Record<string, string> = {}) {
    if (!secret) throw new MeetError(503, "media-server-unavailable", `No API secret for LiveKit: set ${config.livekit.apiSecret}.`);
    count(counters.tokens, kind);
    return {
      url: config.livekit.publicUrl,
      identity,
      token: accessToken({
        apiKey: config.livekit.apiKey,
        apiSecret: secret,
        identity,
        name,
        metadata: JSON.stringify({ kind, ...extra }),
        video: grant(room),
        ttlSeconds: 15 * 60,
        now: clock(),
      }),
    };
  }

  /** A signed-in member joins: straight in, with a token for this room only. */
  async function join(who: Actor, id: string) {
    if (!who.email || who.id.startsWith("token:")) throw new MeetError(403, "forbidden", "Only a signed-in person joins a meeting, not an API token.");
    const m = getRow(id);
    await openRoom(m);
    const access = mint(m.id, `u:${who.id}`, who.name, "member");
    log("info", "member joins", { meeting: m.id, member: who.id });
    return { ...access, meeting: toMeeting(m, who) };
  }

  /** The identities in the room now: from LiveKit when it answers, else from what the last webhooks and checks saw. */
  async function presentNow(meetingId: string): Promise<string[]> {
    try {
      const ps = await lk.listParticipants(meetingId);
      return ps.map((p) => p.identity);
    } catch {
      const open = q.openCall.get(meetingId) as CallRow | undefined;
      return open ? (q.present.all(open.id) as unknown as Array<{ identity: string }>).map((r) => r.identity) : [];
    }
  }

  // ------------------------------------------------------------------ the lobby

  /** What a guest sees before asking to join: the meeting's name and whether it is recorded. The link is the key. */
  function joinInfo(id: string) {
    const m = getRow(id);
    return {
      id: m.id,
      title: m.title,
      organization: config.organization,
      organizer: m.organizer_name,
      guests: config.lobby.guests,
      live: !!q.openCall.get(m.id),
      recording: !!q.activeRecording.get(m.id),
      allowRecording: m.allow_recording === 1,
    };
  }

  function knock(id: string, body: unknown) {
    if (!config.lobby.guests) throw new MeetError(403, "guests-not-allowed", "Guests cannot join meetings here. Sign in with your company account.");
    const m = getRow(id);
    if (!isObj(body)) throw new MeetError(422, "invalid-body", "The body is a JSON object with name.");
    const name = text(body.name, "name", 80)!;
    const email = text(body.email, "email", 254, true)?.toLowerCase() ?? null;
    if (email && !EMAIL.test(email)) throw new MeetError(422, "invalid-body", "email is an email address.");
    expireLobby();
    if ((q.waiting.all(m.id) as unknown[]).length >= MAX_WAITING)
      throw new MeetError(429, "rate-limited", "Too many people are waiting in this meeting's lobby. Try again in a few minutes.");
    const ticket = randomBytes(24).toString("base64url");
    const lobbyId = `lb_${randomBytes(9).toString("base64url")}`;
    db.prepare("INSERT INTO lobby (id, meeting_id, ticket_hash, name, email, state, created_at) VALUES (?, ?, ?, ?, ?, 'waiting', ?)").run(
      lobbyId,
      m.id,
      hash(ticket),
      name,
      email,
      nowIso(),
    );
    count(counters.lobby, "knocked");
    return { ticket, ...lobbyStateOf(getLobbyByTicket(ticket)) };
  }

  function getLobbyByTicket(ticket: string): LobbyRow {
    const r = q.lobbyByTicket.get(hash(ticket)) as LobbyRow | undefined;
    if (!r) throw new MeetError(404, "not-found", "This place in the lobby has ended. Open the meeting's link again.");
    return r;
  }

  function lobbyStateOf(r: LobbyRow) {
    return { id: r.id, state: r.state, meeting: joinInfo(r.meeting_id) };
  }

  /** A guest's browser asks, every few seconds, whether they are let in; once they are, it gets a token. */
  async function lobbyStatus(ticket: string) {
    expireLobby();
    const r = getLobbyByTicket(ticket);
    const out = lobbyStateOf(r);
    if (r.state !== "admitted") return { ...out, join: null };
    // Guests get in only while someone from the company is in the meeting.
    const present = await presentNow(r.meeting_id);
    if (!present.some((i) => i.startsWith("u:"))) return { ...out, join: null };
    const domain = r.email?.split("@")[1] ?? "";
    return { ...out, join: mint(r.meeting_id, `g:${r.id}`, r.name, "guest", domain ? { domain } : {}) };
  }

  function leaveLobby(ticket: string) {
    const r = getLobbyByTicket(ticket);
    if (r.state === "waiting") db.prepare("UPDATE lobby SET state = 'left' WHERE id = ?").run(r.id);
    reports.delete(`g:${r.id}`);
  }

  /** Who may let guests in: the organiser, an admin, or a member in the call now. */
  async function mayAdmit(who: Actor, m: MeetingRow): Promise<boolean> {
    if (atLeast(who.role, "admin")) return true;
    if (!who.email) return false;
    if (who.email.toLowerCase() === m.organizer_email) return true;
    return (await presentNow(m.id)).includes(`u:${who.id}`);
  }

  async function lobbyList(who: Actor, id: string) {
    const m = getRow(id);
    if (!(await mayAdmit(who, m))) throw new MeetError(403, "forbidden", "Only the organiser and people in the call see the lobby.");
    expireLobby();
    const invited = invitedOf(m) ?? [];
    return {
      waiting: (q.waiting.all(m.id) as unknown as LobbyRow[]).map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        invited: !!r.email && invited.includes(r.email),
        since: r.created_at,
      })),
    };
  }

  async function decide(who: Actor, id: string, lobbyId: string, admit: boolean) {
    const m = getRow(id);
    if (!(await mayAdmit(who, m))) throw new MeetError(403, "forbidden", "Only the organiser and people in the call let guests in.");
    const r = q.lobbyEntry.get(lobbyId, m.id) as LobbyRow | undefined;
    if (!r) throw new MeetError(404, "not-found", "No one with this id is in the lobby.");
    if (r.state !== "waiting") throw new MeetError(409, "conflict", `This person is no longer waiting: ${r.state}.`);
    if (admit && !(await presentNow(m.id)).some((i) => i.startsWith("u:")))
      throw new MeetError(409, "conflict", "Guests get in only while someone from the company is in the meeting, and no one is now.");
    db.prepare("UPDATE lobby SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(admit ? "admitted" : "denied", who.name, nowIso(), r.id);
    count(counters.lobby, admit ? "admitted" : "denied");
    log("info", admit ? "guest let in" : "guest not let in", { meeting: m.id, lobby: r.id, by: who.id });
    return { id: r.id, state: admit ? "admitted" : "denied" };
  }

  /** Knocks no one answered go after the file's wait; entries are deleted a day after they were decided or ended. */
  function expireLobby() {
    const before = new Date(clock() - config.lobby.waitMinutes * 60_000).toISOString();
    db.prepare("UPDATE lobby SET state = 'expired' WHERE state = 'waiting' AND created_at < ?").run(before);
    const dayAgo = new Date(clock() - 24 * 3600_000).toISOString();
    db.prepare("DELETE FROM lobby WHERE state != 'waiting' AND state != 'admitted' AND COALESCE(decided_at, created_at) < ?").run(dayAgo);
  }

  // ------------------------------------------------------------------ calls and attendance

  function ensureCall(meetingId: string, sid: string | null, startedAt?: number): CallRow | null {
    if (!q.meeting.get(meetingId)) return null;
    const open = q.openCall.get(meetingId) as CallRow | undefined;
    if (open) {
      if (sid && open.room_sid && open.room_sid !== sid) {
        // LiveKit closed the room and opened a new one between two looks.
        closeCall(open, clock());
      } else {
        if (sid && !open.room_sid) db.prepare("UPDATE calls SET room_sid = ? WHERE id = ?").run(sid, open.id);
        return open;
      }
    }
    const at = new Date(startedAt && startedAt > 0 ? Math.min(startedAt, clock()) : clock()).toISOString();
    db.prepare("INSERT INTO calls (meeting_id, room_sid, started_at) VALUES (?, ?, ?)").run(meetingId, sid, at);
    log("info", "call started", { meeting: meetingId });
    return q.openCall.get(meetingId) as unknown as CallRow;
  }

  function closeCall(c: CallRow, at: number) {
    const iso = new Date(Math.max(at, Date.parse(c.started_at))).toISOString();
    db.prepare("UPDATE calls SET ended_at = ? WHERE id = ?").run(iso, c.id);
    db.prepare("UPDATE attendance SET left_at = ? WHERE call_id = ? AND left_at IS NULL").run(iso, c.id);
    // Nothing of a guest stays but that one was there.
    db.prepare("UPDATE attendance SET name = NULL WHERE call_id = ? AND kind = 'guest'").run(c.id);
    db.prepare("UPDATE lobby SET state = 'expired', decided_at = COALESCE(decided_at, ?) WHERE meeting_id = ? AND state IN ('waiting', 'admitted')").run(
      iso,
      c.meeting_id,
    );
    for (const [k, r] of reports) if (r.meetingId === c.meeting_id) reports.delete(k);
    log("info", "call ended", { meeting: c.meeting_id });
  }

  function kindOf(identity: string): "member" | "guest" | null {
    return identity.startsWith("u:") ? "member" : identity.startsWith("g:") ? "guest" : null;
  }

  function joined(meetingId: string, p: LkParticipant, sid: string | null) {
    const kind = kindOf(p.identity);
    if (!kind) return;
    const c = ensureCall(meetingId, sid);
    if (!c) return;
    const member = kind === "member" ? (q.user.get(p.identity.slice(2)) as { email: string; name: string } | undefined) : undefined;
    const at = new Date(p.joinedAt > 0 ? Math.min(p.joinedAt, clock()) : clock()).toISOString();
    db.prepare(
      `INSERT INTO attendance (call_id, identity, kind, email, name, joined_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (call_id, identity) DO UPDATE SET left_at = NULL, name = excluded.name`,
    ).run(c.id, p.identity, kind, member?.email.toLowerCase() ?? null, p.name || member?.name || null, at);
    // People who come in while a recording runs see its mark; they are listed with it.
    const rec = q.activeRecording.get(meetingId) as RecordingRow | undefined;
    if (rec) addToRecording(rec, [{ identity: p.identity, kind, name: kind === "member" ? p.name || member?.name || null : null }]);
  }

  function left(meetingId: string, identity: string) {
    const c = q.openCall.get(meetingId) as CallRow | undefined;
    if (c) db.prepare("UPDATE attendance SET left_at = ? WHERE call_id = ? AND identity = ? AND left_at IS NULL").run(nowIso(), c.id, identity);
    reports.delete(identity);
  }

  function syncParticipants(meetingId: string, sid: string | null, ps: LkParticipant[]) {
    const c = ensureCall(meetingId, sid);
    if (!c) return;
    const now = new Set(ps.filter((p) => kindOf(p.identity) && p.state !== "DISCONNECTED").map((p) => p.identity));
    const there = new Set((q.present.all(c.id) as unknown as Array<{ identity: string }>).map((r) => r.identity));
    for (const p of ps) if (now.has(p.identity) && !there.has(p.identity)) joined(meetingId, p, sid);
    for (const i of there) if (!now.has(i)) left(meetingId, i);
  }

  /** Brings the calls in step with LiveKit: rooms open and closed, people in and out, recordings done. */
  async function reconcile() {
    const started = performance.now();
    let rooms;
    try {
      rooms = await lk.listRooms();
      Object.assign(links.livekit, { ok: true, at: nowIso(), error: null, ms: Math.round(performance.now() - started), rooms: rooms.length });
    } catch (err) {
      Object.assign(links.livekit, { ok: false, at: nowIso(), error: (err as Error).message, ms: null });
      expireLobby();
      return;
    }
    const names = new Set(rooms.map((r) => r.name));
    for (const c of q.openCalls.all() as unknown as CallRow[]) if (!names.has(c.meeting_id)) closeCall(c, clock());
    for (const r of rooms) {
      if (!q.meeting.get(r.name)) continue;
      try {
        syncParticipants(r.name, r.sid || null, await lk.listParticipants(r.name));
      } catch (err) {
        log("warn", "cannot list a room's participants", { room: r.name, error: (err as Error).message });
      }
    }
    expireLobby();
    const pending = db.prepare("SELECT * FROM recordings WHERE state IN ('recording', 'saving')").all() as unknown as RecordingRow[];
    if (pending.length) {
      try {
        const all = await lk.listEgress();
        Object.assign(links.egress, { ok: true, at: nowIso(), error: null });
        for (const e of all) if (pending.some((p) => p.egress_id === e.egressId)) fromEgress(e);
      } catch (err) {
        Object.assign(links.egress, { ok: false, at: nowIso(), error: (err as Error).message });
      }
    }
  }

  /** What LiveKit's webhooks say, as it happens; reconcile() catches anything missed. */
  function webhook(e: WebhookEvent) {
    counters.webhooks++;
    Object.assign(links.webhooks, { ok: true, at: nowIso(), error: null, count: links.webhooks.count + 1, last: e.event });
    const room = e.room?.name ?? e.egress?.roomName ?? "";
    switch (e.event) {
      case "room_started":
        if (e.room) ensureCall(room, e.room.sid || null, e.room.createdAt);
        break;
      case "room_finished": {
        const c = q.openCall.get(room) as CallRow | undefined;
        if (c && (!c.room_sid || !e.room?.sid || c.room_sid === e.room.sid)) closeCall(c, clock());
        break;
      }
      case "participant_joined":
        if (e.participant && q.meeting.get(room)) joined(room, e.participant, e.room?.sid || null);
        break;
      case "participant_left":
        if (e.participant) left(room, e.participant.identity);
        break;
      case "egress_started":
      case "egress_updated":
      case "egress_ended":
        if (e.egress) {
          Object.assign(links.egress, { ok: true, at: nowIso(), error: null });
          fromEgress(e.egress);
        }
        break;
    }
  }

  // ------------------------------------------------------------------ recordings

  const peopleOf = (r: RecordingRow) => JSON.parse(r.people) as Person[];

  function addToRecording(r: RecordingRow, add: Person[]) {
    const people = peopleOf(r);
    for (const p of add) if (!people.some((x) => x.identity === p.identity)) people.push(p);
    db.prepare("UPDATE recordings SET people = ?, guests = ? WHERE id = ?").run(JSON.stringify(people), people.filter((p) => p.kind === "guest").length, r.id);
  }

  function fromEgress(e: LkEgress) {
    const r = db.prepare("SELECT * FROM recordings WHERE egress_id = ?").get(e.egressId) as RecordingRow | undefined;
    if (!r || r.state === "ready" || r.state === "failed") return;
    if (e.state === "starting" || e.state === "active") return;
    if (e.state === "ending") {
      db.prepare("UPDATE recordings SET state = 'saving' WHERE id = ?").run(r.id);
      return;
    }
    const endedAt = e.endedAt > 0 ? e.endedAt : clock();
    const ok = e.state === "complete" || e.state === "limit_reached" || (!!e.file && e.file.size > 0);
    const deleteOn = new Date(endedAt + r.keep_days * 24 * 3600_000).toISOString();
    db.prepare("UPDATE recordings SET state = ?, size = ?, duration_s = ?, error = ?, ended_at = ?, delete_on = ? WHERE id = ?").run(
      ok ? "ready" : "failed",
      e.file?.size ?? 0,
      Math.round((e.file?.durationMs ?? endedAt - Date.parse(r.started_at)) / 1000),
      ok ? null : (e.error ?? "Egress stopped without a file."),
      new Date(endedAt).toISOString(),
      ok ? deleteOn : null,
      r.id,
    );
    count(counters.recordings, ok ? "ready" : "failed");
    log(ok ? "info" : "warn", ok ? "recording saved" : "recording failed", { recording: r.id, error: e.error });
  }

  async function startRecording(who: Actor, id: string) {
    const m = getRow(id);
    if (!who.email || who.email.toLowerCase() !== m.organizer_email) throw new MeetError(403, "forbidden", "Only the meeting's organiser starts a recording.");
    if (m.allow_recording !== 1) throw new MeetError(403, "forbidden", "Recording was not allowed when this meeting was made.");
    const p = policyFor(who.id, who.email);
    if (!p.allowed) throw new MeetError(403, "forbidden", "meet.yaml does not allow you to record.");
    const call = q.openCall.get(m.id) as CallRow | undefined;
    if (!call) throw new MeetError(409, "conflict", "The meeting is not live: a recording starts once people are in it.");
    if (q.activeRecording.get(m.id)) throw new MeetError(409, "conflict", "This meeting is being recorded already.");
    const recId = `rec_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
    const storage = config.recording!.storage;
    const file = joinPath(storage, `${recId}.mp4`);
    let egress: LkEgress;
    try {
      if (!existsSync(storage)) mkdirSync(storage, { recursive: true });
    } catch {
      // Egress makes it in its own container; Meet needs it only to read and delete the files.
    }
    try {
      egress = await lk.startRecording(m.id, file);
      Object.assign(links.egress, { ok: true, at: nowIso(), error: null });
    } catch (err) {
      Object.assign(links.egress, { ok: false, at: nowIso(), error: (err as Error).message });
      throw new MeetError(503, "media-server-unavailable", `Egress could not start the recording: ${(err as Error).message}`);
    }
    const people = (q.present.all(call.id) as unknown as Array<{ identity: string; kind: "member" | "guest"; name: string | null }>).map((x) => ({
      identity: x.identity,
      kind: x.kind,
      name: x.kind === "member" ? x.name : null,
    }));
    db.prepare(
      `INSERT INTO recordings (id, meeting_id, egress_id, title, started_by_email, started_by_name, group_id, group_name, keep_days, state, file, people, guests, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?, ?)`,
    ).run(
      recId,
      m.id,
      egress.egressId,
      m.title,
      who.email.toLowerCase(),
      who.name,
      p.group,
      p.groupName,
      p.keepDays,
      file,
      JSON.stringify(people),
      people.filter((x) => x.kind === "guest").length,
      nowIso(),
    );
    count(counters.recordings, "started");
    log("info", "recording started", { meeting: m.id, recording: recId, by: who.id });
    return toRecording(q.recording.get(recId) as unknown as RecordingRow, who);
  }

  async function stopRecording(who: Actor, id: string) {
    const m = getRow(id);
    const r = q.activeRecording.get(m.id) as RecordingRow | undefined;
    if (!r) throw new MeetError(409, "conflict", "This meeting is not being recorded.");
    const mine = !!who.email && who.email.toLowerCase() === m.organizer_email;
    if (!mine && !atLeast(who.role, "admin")) throw new MeetError(403, "forbidden", "Only the organiser or an admin stops a recording.");
    try {
      const e = await lk.stopRecording(r.egress_id!);
      db.prepare("UPDATE recordings SET state = 'saving' WHERE id = ?").run(r.id);
      fromEgress(e);
    } catch (err) {
      throw new MeetError(503, "media-server-unavailable", `Egress could not stop the recording: ${(err as Error).message}`);
    }
    return toRecording(q.recording.get(r.id) as unknown as RecordingRow, who);
  }

  function seesRecording(r: RecordingRow, who: Actor): boolean {
    if (atLeast(who.role, "viewer")) return true;
    if (!who.email) return false;
    return r.started_by_email === who.email.toLowerCase() || peopleOf(r).some((p) => p.identity === `u:${who.id}`);
  }

  function toRecording(r: RecordingRow, who: Actor) {
    const people = peopleOf(r);
    return {
      id: r.id,
      meetingId: r.meeting_id,
      title: r.title,
      state: r.state,
      startedBy: { email: r.started_by_email, name: r.started_by_name },
      group: { id: r.group_id, name: r.group_name, keepDays: r.keep_days },
      startedAt: r.started_at,
      endedAt: r.ended_at,
      seconds: r.duration_s,
      size: r.size,
      file: r.file.split("/").slice(-2).join("/"),
      people: people.filter((p) => p.kind === "member").map((p) => p.name ?? "?"),
      guests: r.guests,
      deleteOn: r.delete_on,
      error: r.error,
      canDelete: atLeast(who.role, "admin") || (!!who.email && who.email.toLowerCase() === r.started_by_email),
    };
  }
  type Recording = ReturnType<typeof toRecording>;

  function getRecordingRow(who: Actor, id: string): RecordingRow {
    const r = q.recording.get(id) as RecordingRow | undefined;
    if (!r || !seesRecording(r, who)) throw new MeetError(404, "not-found", "There is no recording with this id that you can see.");
    return r;
  }

  function recordingPolicyYaml(): string {
    try {
      const doc = parse(yaml) as Record<string, unknown> | null;
      return doc?.recording ? stringify({ recording: doc.recording }).trimEnd() : "recording: off";
    } catch {
      return "";
    }
  }

  function recordings(who: Actor, query: string | null) {
    const rows = db.prepare("SELECT * FROM recordings ORDER BY started_at DESC").all() as unknown as RecordingRow[];
    const seen = rows.filter((r) => seesRecording(r, who));
    const needle = query?.trim().toLowerCase() ?? "";
    const items: Recording[] = seen.filter((r) => !needle || `${r.title} ${r.started_by_name}`.toLowerCase().includes(needle)).map((r) => toRecording(r, who));
    const kept = seen.filter((r) => r.state === "ready");
    let capacity: number | null = null;
    const storage = config.recording?.storage;
    try {
      if (storage && existsSync(storage)) {
        const s = statfsSync(storage);
        capacity = s.blocks * s.bsize;
      }
    } catch {
      capacity = null;
    }
    const month = new Date(clock() - 30 * 24 * 3600_000).toISOString();
    const next = kept.filter((r) => r.delete_on).sort((a, b) => a.delete_on!.localeCompare(b.delete_on!))[0];
    return {
      recordings: items,
      totals: {
        kept: kept.length,
        bytes: kept.reduce((n, r) => n + r.size, 0),
        capacity,
        meetingsLast30Days: (db.prepare("SELECT COUNT(DISTINCT meeting_id) AS n FROM calls WHERE started_at >= ?").get(month) as { n: number }).n,
        nextDeletion: next ? { on: next.delete_on!, title: next.title, keepDays: next.keep_days } : null,
      },
      policy: {
        on: !!config.recording,
        groups: (config.recording?.allowedFor ?? []).map((a) => ({ id: a.group, name: groupName(a.group), keepDays: a.keepDays })),
        never: (config.recording?.neverFor ?? []).map((g) => ({ id: g, name: groupName(g) })),
        yaml: recordingPolicyYaml(),
      },
    };
  }

  /** The file of a ready recording, inside the storage folder only. */
  function recordingFile(who: Actor, id: string): { path: string; size: number; name: string } {
    const r = getRecordingRow(who, id);
    if (r.state !== "ready") throw new MeetError(409, "conflict", "The recording is not saved yet.");
    const storage = config.recording?.storage;
    const path = normalize(r.file);
    if (!storage || !path.startsWith(normalize(storage) + "/") || !existsSync(path))
      throw new MeetError(404, "not-found", "The recording's file is not in the storage folder.");
    const date = r.started_at.slice(0, 10);
    return {
      path,
      size: statSync(path).size,
      name: `${
        r.title
          .replace(/[\\/:*?"<>|]+/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "meeting"
      } ${date}.mp4`,
    };
  }

  function deleteFile(r: RecordingRow) {
    const storage = config.recording?.storage;
    const path = normalize(r.file);
    if (storage && path.startsWith(normalize(storage) + "/") && existsSync(path)) unlinkSync(path);
    // Egress also writes a small JSON manifest next to the file.
    const manifest = path.replace(/\.mp4$/, ".json");
    if (storage && manifest !== path && manifest.startsWith(normalize(storage) + "/") && existsSync(manifest)) unlinkSync(manifest);
  }

  function deleteRecording(who: Actor, id: string) {
    const r = getRecordingRow(who, id);
    if (!toRecording(r, who).canDelete) throw new MeetError(403, "forbidden", "Only who started a recording, or an admin, deletes it.");
    if (r.state === "recording") throw new MeetError(409, "conflict", "Stop the recording before deleting it.");
    try {
      deleteFile(r);
    } catch (err) {
      throw new MeetError(503, "media-server-unavailable", `The file could not be deleted: ${(err as Error).message}`);
    }
    db.prepare("DELETE FROM recordings WHERE id = ?").run(r.id);
    count(counters.recordings, "deleted");
    log("info", "recording deleted", { recording: r.id, by: who.id });
  }

  /** Deletes recordings whose day has come, as the file's keep_days set when they were made. */
  function retention() {
    const due = db.prepare("SELECT * FROM recordings WHERE delete_on IS NOT NULL AND delete_on <= ?").all(nowIso()) as unknown as RecordingRow[];
    for (const r of due) {
      try {
        deleteFile(r);
        db.prepare("DELETE FROM recordings WHERE id = ?").run(r.id);
        count(counters.recordings, "expired");
        log("info", "recording deleted after its days", { recording: r.id });
      } catch (err) {
        log("warn", "recording due for deletion could not be deleted", { recording: r.id, error: (err as Error).message });
      }
    }
    // Failed recordings have no file; their entry goes after a week.
    db.prepare("DELETE FROM recordings WHERE state = 'failed' AND started_at < ?").run(new Date(clock() - 7 * 24 * 3600_000).toISOString());
  }

  // ------------------------------------------------------------------ connections and the server

  function report(identity: string, name: string, guest: boolean, meetingId: string, body: unknown) {
    if (!isObj(body)) throw new MeetError(422, "invalid-body", "The body is a JSON object.");
    const n = (v: unknown, at: string, max: number, optional = true): number | null => {
      if ((v === undefined || v === null) && optional) return null;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) throw new MeetError(422, "invalid-body", `${at} is a number from 0 to ${max}.`);
      return v;
    };
    const path = (body.path ?? "unknown") as MediaPath;
    if (!PATHS.includes(path)) throw new MeetError(422, "invalid-body", `path is one of ${PATHS.join(", ")}.`);
    reports.set(identity, {
      identity,
      name,
      guest,
      meetingId,
      path,
      rttMs: n(body.rttMs, "rttMs", 60_000),
      lossPercent: n(body.lossPercent, "lossPercent", 100),
      sendKbps: n(body.sendKbps, "sendKbps", 1_000_000) ?? 0,
      receiveKbps: n(body.receiveKbps, "receiveKbps", 1_000_000) ?? 0,
      sending: (text(body.sending, "sending", 40, true) ?? "").slice(0, 40),
      browser: (text(body.browser, "browser", 40, true) ?? "").slice(0, 40),
      at: clock(),
    });
  }

  function memberReport(who: Actor, id: string, body: unknown) {
    if (!who.email || who.id.startsWith("token:")) throw new MeetError(403, "forbidden", "Only people in the call send how they connect.");
    getRow(id);
    report(`u:${who.id}`, who.name, false, id, body);
  }

  function guestReport(ticket: string, body: unknown) {
    const r = getLobbyByTicket(ticket);
    if (r.state !== "admitted") throw new MeetError(409, "conflict", "Only guests let in send how they connect.");
    report(`g:${r.id}`, r.name, true, r.meeting_id, body);
  }

  const fresh = () => [...reports.values()].filter((r) => clock() - r.at < 90_000);

  /** A sample a minute of what the browsers send and receive through the server; two days are kept. */
  function sampleMedia() {
    const rs = fresh();
    const at = new Date(Math.floor(clock() / 60_000) * 60_000).toISOString();
    db.prepare("INSERT OR REPLACE INTO media_samples (at, total_kbps, relayed_kbps, people) VALUES (?, ?, ?, ?)").run(
      at,
      Math.round(rs.reduce((s, r) => s + r.sendKbps + r.receiveKbps, 0)),
      Math.round(rs.filter((r) => r.path.startsWith("turn")).reduce((s, r) => s + r.sendKbps + r.receiveKbps, 0)),
      rs.length,
    );
    db.prepare("DELETE FROM media_samples WHERE at < ?").run(new Date(clock() - 2 * 24 * 3600_000).toISOString());
  }

  async function sampleMetrics() {
    const url = config.livekit.metricsUrl;
    if (!url) return;
    try {
      const res = await f(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const m = readProcessMetrics(await res.text());
      const now = clock();
      const prev = process_.last;
      const cores = m.cores;
      process_ = {
        cpuPercent:
          prev && m.cpuSeconds !== null && now > prev.at
            ? Math.max(0, Math.round(((m.cpuSeconds - prev.cpu) / ((now - prev.at) / 1000) / (cores || 1)) * 100))
            : process_.cpuPercent,
        memoryBytes: m.memoryBytes,
        startedAt: m.startedAt,
        cores,
        last: m.cpuSeconds !== null ? { cpu: m.cpuSeconds, at: now } : prev,
      };
      Object.assign(links.metrics, { ok: true, at: nowIso(), error: null });
    } catch (err) {
      Object.assign(links.metrics, { ok: false, at: nowIso(), error: `${url}: ${(err as Error).message}` });
    }
  }

  async function checkTurnNow() {
    turn = await Promise.all(config.turn.map((t) => turnCheck(t.host, t.port, t.transport)));
  }

  function server() {
    const rs = fresh();
    const titles = new Map<string, string>();
    const titleOf = (id: string) => {
      if (!titles.has(id)) titles.set(id, (q.meeting.get(id) as MeetingRow | undefined)?.title ?? id);
      return titles.get(id)!;
    };
    const today = dayRange(dayOf(clock(), config.timeZone), config.timeZone);
    const samples = db
      .prepare("SELECT at, total_kbps, relayed_kbps FROM media_samples WHERE at >= ? ORDER BY at")
      .all(new Date(today.from).toISOString()) as Array<{ at: string; total_kbps: number; relayed_kbps: number }>;
    // Every 15 minutes since midnight, the mean of the minutes in it.
    const buckets: Array<{ at: string; totalMbps: number; relayedMbps: number }> = [];
    for (let t = today.from; t <= clock(); t += 15 * 60_000) {
      const inside = samples.filter((s) => Date.parse(s.at) >= t && Date.parse(s.at) < t + 15 * 60_000);
      const mean = (k: "total_kbps" | "relayed_kbps") => (inside.length ? inside.reduce((n, s) => n + s[k], 0) / inside.length / 1000 : 0);
      buckets.push({
        at: new Date(t).toISOString(),
        totalMbps: Math.round(mean("total_kbps") * 10) / 10,
        relayedMbps: Math.round(mean("relayed_kbps") * 10) / 10,
      });
    }
    const live = q.openCalls.all() as unknown as CallRow[];
    const inCalls = live.reduce((n, c) => n + (q.present.all(c.id) as unknown[]).length, 0);
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM lobby WHERE state = 'waiting'").get() as { n: number }).n;
    return {
      livekit: {
        url: config.livekit.url,
        publicUrl: config.livekit.publicUrl,
        ...links.livekit,
        mediaPorts: config.livekit.mediaPorts,
        cpuPercent: process_.cpuPercent,
        cores: process_.cores,
        memoryBytes: process_.memoryBytes,
        startedAt: process_.startedAt ? new Date(process_.startedAt).toISOString() : null,
        metrics: config.livekit.metricsUrl ? { ...links.metrics } : null,
      },
      limits: config.limits,
      live: { meetings: live.length, people: inCalls, lobby: waiting },
      bandwidth: {
        nowMbps: Math.round((rs.reduce((s, r) => s + r.sendKbps + r.receiveKbps, 0) / 1000) * 10) / 10,
        capacityMbps: config.limits.bandwidth,
        samples: buckets,
      },
      turn: turn.length ? turn : config.turn.map((t) => ({ ...t, ok: null, ms: null, error: null, at: null })),
      connections: rs
        .map((r) => ({
          identity: r.identity,
          name: r.name,
          guest: r.guest,
          meetingId: r.meetingId,
          meeting: titleOf(r.meetingId),
          path: r.path,
          rttMs: r.rttMs,
          lossPercent: r.lossPercent,
          sending: r.sending,
          browser: r.browser,
          at: new Date(r.at).toISOString(),
        }))
        .sort((a, b) => a.meeting.localeCompare(b.meeting) || a.name.localeCompare(b.name)),
    };
  }

  function integrations() {
    const withGroups = (db.prepare("SELECT COUNT(*) AS n FROM person_groups WHERE groups != '[]'").get() as { n: number }).n;
    return {
      livekit: { url: config.livekit.url, publicUrl: config.livekit.publicUrl, secret: !!secret, ...links.livekit },
      webhooks: { url: `${publicUrl}/api/v1/livekit/webhook`, ...links.webhooks },
      egress: { on: !!config.recording, storage: config.recording?.storage ?? null, ...links.egress },
      metrics: { url: config.livekit.metricsUrl, ...links.metrics },
      identity: { peopleWithGroups: withGroups, fileGroups: Object.keys(config.groups).length },
      turn: { listeners: config.turn.length, reachable: turn.filter((t) => t.ok).length },
      api: { meetings: `${publicUrl}/api/v1/meetings` },
    };
  }

  function settings() {
    return { file: opts.fileState?.() ?? null, yaml, config };
  }

  function gauges() {
    const live = q.openCalls.all() as unknown as CallRow[];
    let members = 0;
    let guests = 0;
    for (const c of live)
      for (const p of q.present.all(c.id) as unknown as Array<{ kind: string }>) {
        if (p.kind === "guest") guests++;
        else members++;
      }
    const recs = db.prepare("SELECT state, COUNT(*) AS n FROM recordings GROUP BY state").all() as Array<{ state: string; n: number }>;
    return {
      live: live.length,
      participants: { member: members, guest: guests },
      lobby: (db.prepare("SELECT COUNT(*) AS n FROM lobby WHERE state = 'waiting'").get() as { n: number }).n,
      recordings: Object.fromEntries(recs.map((r) => [r.state, r.n])),
      livekitUp: links.livekit.ok === false ? 0 : 1,
      turn: turn.map((t) => ({ listener: `${t.transport}://${t.host}:${t.port}`, up: t.ok ? 1 : 0 })),
      counters,
    };
  }

  return {
    setConfig,
    config: () => config,
    mediaOrigins,
    noteGroups,
    me,
    list,
    get,
    create,
    update,
    remove,
    join,
    joinInfo,
    knock,
    lobbyStatus,
    leaveLobby,
    lobbyList,
    admit: (who: Actor, id: string, lobbyId: string) => decide(who, id, lobbyId, true),
    deny: (who: Actor, id: string, lobbyId: string) => decide(who, id, lobbyId, false),
    startRecording,
    stopRecording,
    recordings,
    recording: (who: Actor, id: string) => toRecording(getRecordingRow(who, id), who),
    recordingFile,
    deleteRecording,
    retention,
    memberReport,
    guestReport,
    reconcile,
    webhook,
    webhookKeys: () => ({ apiKey: config.livekit.apiKey, apiSecret: secret }),
    sampleMedia,
    sampleMetrics,
    checkTurnNow,
    server,
    integrations,
    settings,
    gauges,
  };
}

export type Meet = ReturnType<typeof createMeet>;
