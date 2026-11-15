// Meet's settings, from one YAML file (MEET_CONFIG): where LiveKit is, how many meetings and people it carries, whether
// guests may knock, the groups people are in, who may record and how long recordings are kept, and the TURN listeners
// to check. As in the other products, the file is the only way in: no screen or API route changes these. It is applied
// whole or not at all, read again within a minute of a change, and a file with a mistake leaves the last good version
// in place. Meetings, the lobby and recordings are kept in the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parse } from "yaml";

export type Video = "360p" | "540p" | "720p" | "1080p";
export type Transport = "udp" | "tcp" | "tls";

export interface Group {
  name: string;
  /** Email addresses, lower case. People are also in the groups their identity provider sent at sign-in. */
  members: string[];
}

export interface RecordingPolicy {
  /** The groups whose organisers may record, in order: the first that matches sets how long the file is kept. */
  allowedFor: Array<{ group: string; keepDays: number }>;
  /** Groups whose members never record, even when another of their groups would allow it. */
  neverFor: string[];
  /** Where Egress writes the files and Meet reads them: the same folder in both containers. */
  storage: string;
}

export interface Config {
  timeZone: string;
  /** The company's name in the pages: "People from Acme Corp come straight in". */
  organization: string | null;
  livekit: {
    /** LiveKit's API, from Meet's container. */
    url: string;
    /** The address browsers connect to, ws:// or wss://. The pages' CSP allows it. */
    publicUrl: string;
    apiKey: string;
    /** The name of the environment variable that holds the API secret, never the secret itself. */
    apiSecret: string;
    /** LiveKit's Prometheus endpoint, for the Server page's CPU and memory; null when it is not published. */
    metricsUrl: string | null;
    /** The media ports as the firewall opens them, shown on the Server page. */
    mediaPorts: string | null;
  };
  limits: {
    /** Meetings live at once. */
    meetings: number;
    /** People in one meeting. */
    people: number;
    video: Video;
    /** What the server's link carries, in Mbit/s, shown next to what flows now. */
    bandwidth: number | null;
  };
  lobby: {
    /** People without an account may ask to join through the lobby. */
    guests: boolean;
    /** A knock no one answers goes away after this many minutes. */
    waitMinutes: number;
  };
  groups: Record<string, Group>;
  /** null: no one records. */
  recording: RecordingPolicy | null;
  turn: Array<{ host: string; port: number; transport: Transport }>;
}

export interface ConfigFileState {
  path: string;
  appliedAt: string | null;
  error: string | null;
  warnings: string[];
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const TOP = ["time_zone", "organization", "livekit", "limits", "lobby", "groups", "recording", "turn"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if ((typeof v !== "string" && typeof v !== "number") || !String(v).trim() || String(v).length > max)
    throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return String(v).trim();
}

function whole(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${at} is a whole number from ${min} to ${max}.`);
  return v;
}

function url(v: unknown, at: string, protocols: string[]): string {
  const u = typeof v === "string" ? URL.parse(v.trim()) : null;
  if (!u || !protocols.includes(u.protocol) || u.username || u.password)
    throw new Error(`${at} is an address starting with ${protocols.map((p) => `${p}//`).join(" or ")}.`);
  return (u.origin + u.pathname).replace(/\/$/, "");
}

/** "15m", "2h", "90d" or a number of the given unit, as minutes or days. */
function duration(v: unknown, at: string, unit: "m" | "d", max: number): number {
  const m = typeof v === "number" ? [String(v), String(v), unit] : typeof v === "string" ? /^\s*(\d+)\s*(m|h|d)?\s*$/.exec(v) : null;
  const n = m ? Number(m[1]) : NaN;
  const u = (m?.[2] ?? unit) as "m" | "h" | "d";
  const minutes = u === "m" ? n : u === "h" ? n * 60 : n * 24 * 60;
  const value = unit === "m" ? minutes : minutes / (24 * 60);
  if (!m || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${at} is a length such as ${unit === "m" ? "15m or 2h" : "30d"}.`);
  return value;
}

function timeZone(v: unknown): string {
  const z = text(v, "time_zone", 64);
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
  } catch {
    throw new Error(`time_zone: ${z} is not a time zone, such as Europe/Istanbul.`);
  }
  return z;
}

function groupId(v: unknown, at: string): string {
  const id = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!ID.test(id)) throw new Error(`${at} is a group's id: small letters, digits, - and _.`);
  return id;
}

function parseLivekit(v: unknown): Config["livekit"] {
  const d = {
    url: "http://livekit:7880",
    publicUrl: "ws://localhost:7880",
    apiKey: "meet",
    apiSecret: "MEET_LIVEKIT_SECRET",
    metricsUrl: null,
    mediaPorts: null,
  };
  if (v === undefined || v === null) return d;
  if (!isObj(v)) throw new Error("livekit is a map with url, public_url, api_key and api_secret.");
  keys(v, "livekit", ["url", "public_url", "api_key", "api_secret", "metrics_url", "media_ports"]);
  const secret = v.api_secret ?? d.apiSecret;
  if (typeof secret !== "string" || !ENV.test(secret))
    throw new Error("livekit.api_secret is the name of an environment variable, such as MEET_LIVEKIT_SECRET, never the secret itself.");
  return {
    url: v.url === undefined ? d.url : url(v.url, "livekit.url", ["http:", "https:"]),
    publicUrl: v.public_url === undefined ? d.publicUrl : url(v.public_url, "livekit.public_url", ["wss:", "ws:"]),
    apiKey: v.api_key === undefined ? d.apiKey : text(v.api_key, "livekit.api_key", 64),
    apiSecret: secret,
    metricsUrl: v.metrics_url === undefined || v.metrics_url === null ? null : url(v.metrics_url, "livekit.metrics_url", ["http:", "https:"]),
    mediaPorts: v.media_ports === undefined || v.media_ports === null ? null : text(v.media_ports, "livekit.media_ports"),
  };
}

function parseLimits(v: unknown): Config["limits"] {
  const d: Config["limits"] = { meetings: 20, people: 50, video: "720p", bandwidth: null };
  if (v === undefined || v === null) return d;
  if (!isObj(v)) throw new Error("limits is a map with meetings, people, video and bandwidth.");
  keys(v, "limits", ["meetings", "people", "video", "bandwidth"]);
  let bandwidth = d.bandwidth;
  if (v.bandwidth !== undefined && v.bandwidth !== null) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(mbit\/s|mbps|gbit\/s|gbps)?\s*$/i.exec(String(v.bandwidth));
    if (!m) throw new Error("limits.bandwidth is what the server's link carries, such as 400 Mbit/s or 1 Gbit/s.");
    bandwidth = Number(m[1]) * (m[2]?.toLowerCase().startsWith("g") ? 1000 : 1);
  }
  const video = v.video ?? d.video;
  if (!["360p", "540p", "720p", "1080p"].includes(String(video))) throw new Error("limits.video is 360p, 540p, 720p or 1080p.");
  return {
    meetings: v.meetings === undefined ? d.meetings : whole(v.meetings, "limits.meetings", 1, 10_000),
    people: v.people === undefined ? d.people : whole(v.people, "limits.people", 2, 1_000),
    video: String(video) as Video,
    bandwidth,
  };
}

function parseLobby(v: unknown): Config["lobby"] {
  const d = { guests: true, waitMinutes: 15 };
  if (v === undefined || v === null) return d;
  if (!isObj(v)) throw new Error("lobby is a map with guests and wait.");
  keys(v, "lobby", ["guests", "wait"]);
  if (v.guests !== undefined && typeof v.guests !== "boolean") throw new Error("lobby.guests is true or false.");
  return {
    guests: (v.guests as boolean | undefined) ?? d.guests,
    waitMinutes: v.wait === undefined ? d.waitMinutes : duration(v.wait, "lobby.wait", "m", 24 * 60),
  };
}

function parseGroups(v: unknown): Record<string, Group> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new Error("groups is a map from a group's id to its name and members.");
  const out: Record<string, Group> = {};
  for (const [raw, g] of Object.entries(v)) {
    const id = groupId(raw, `groups.${raw}`);
    const at = `groups.${id}`;
    const members = Array.isArray(g) ? g : isObj(g) ? (g.members ?? []) : null;
    if (!members || !Array.isArray(members)) throw new Error(`${at} is a list of email addresses, or a map with name and members.`);
    if (isObj(g)) keys(g, at, ["name", "members"]);
    const emails = members.map((m, i) => {
      const e = typeof m === "string" ? m.trim().toLowerCase() : "";
      if (!EMAIL.test(e)) throw new Error(`${at}.members[${i}] is an email address.`);
      return e;
    });
    out[id] = { name: isObj(g) && g.name !== undefined ? text(g.name, `${at}.name`) : raw, members: [...new Set(emails)] };
  }
  return out;
}

function parseRecording(v: unknown, warnings: string[], groups: Record<string, Group>): RecordingPolicy | null {
  if (v === undefined || v === null || v === false) return null;
  if (!isObj(v)) throw new Error("recording is a map with allowed_for, never_for and storage.");
  keys(v, "recording", ["allowed_for", "never_for", "storage", "announce"]);
  // Everyone in a recorded meeting is told, and people joining later before they come in; it cannot be turned off.
  if (v.announce !== undefined && v.announce !== true)
    throw new Error("recording.announce can only be true: everyone in a recorded meeting sees that it is, and people joining are told first.");
  if (!Array.isArray(v.allowed_for)) throw new Error("recording.allowed_for is a list of groups, each with keep_days.");
  const allowedFor = v.allowed_for.map((a, i) => {
    const at = `recording.allowed_for[${i}]`;
    if (!isObj(a)) throw new Error(`${at} is a map with group and keep_days.`);
    keys(a, at, ["group", "keep_days"]);
    return { group: groupId(a.group, `${at}.group`), keepDays: whole(a.keep_days, `${at}.keep_days`, 1, 3650) };
  });
  const neverFor = v.never_for === undefined ? [] : Array.isArray(v.never_for) ? v.never_for.map((g, i) => groupId(g, `recording.never_for[${i}]`)) : null;
  if (!neverFor) throw new Error("recording.never_for is a list of groups.");
  const storage = v.storage === undefined ? "/recordings" : text(v.storage, "recording.storage", 255);
  if (!isAbsolute(storage)) throw new Error("recording.storage is an absolute path, the folder Egress writes to, such as /recordings.");
  for (const g of new Set([...allowedFor.map((a) => a.group), ...neverFor]))
    if (!groups[g]) warnings.push(`recording names the group ${g}, which is not under groups: only people whose identity provider sends it are in it.`);
  return { allowedFor, neverFor, storage: storage.replace(/\/+$/, "") || "/" };
}

function parseTurn(v: unknown): Config["turn"] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("turn is a list of listeners, each with host, port and transport.");
  return v.map((t, i) => {
    const at = `turn[${i}]`;
    if (!isObj(t)) throw new Error(`${at} is a map with host, port and transport.`);
    keys(t, at, ["host", "port", "transport"]);
    const host = text(t.host, `${at}.host`, 253);
    if (!HOST.test(host)) throw new Error(`${at}.host is a host name or address.`);
    const transport = t.transport ?? "udp";
    if (!["udp", "tcp", "tls"].includes(String(transport))) throw new Error(`${at}.transport is udp, tcp or tls.`);
    return { host, port: whole(t.port, `${at}.port`, 1, 65535), transport: String(transport) as Transport };
  });
}

/** Reads the file's text; throws with the entry and field to fix. Returns the settings and what to fix that did not stop it. */
export function parseConfig(raw: string): { config: Config; warnings: string[] } {
  let doc: unknown;
  try {
    doc = parse(raw) ?? {};
  } catch (err) {
    throw new Error(`The file is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!isObj(doc)) throw new Error("The file is a map with livekit, limits, lobby, groups, recording and turn.");
  keys(doc, "The file", TOP);
  const warnings: string[] = [];
  const groups = parseGroups(doc.groups);
  return {
    config: {
      timeZone: doc.time_zone === undefined ? "UTC" : timeZone(doc.time_zone),
      organization: doc.organization === undefined || doc.organization === null ? null : text(doc.organization, "organization"),
      livekit: parseLivekit(doc.livekit),
      limits: parseLimits(doc.limits),
      lobby: parseLobby(doc.lobby),
      groups,
      recording: parseRecording(doc.recording, warnings, groups),
      turn: parseTurn(doc.turn),
    },
    warnings,
  };
}

/** Reads the file now and every minute; applies it when it changed and is valid. */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => void,
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const { config, warnings } = parseConfig(raw);
      apply(config, raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null, warnings });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
