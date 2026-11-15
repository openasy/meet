// How this browser connects to the call, from WebRTC's own statistics: the path the media takes (direct, or relayed
// through TURN over UDP, TCP or TLS), the round trip, the loss, and what it sends. It goes to Meet every 15 seconds
// for the Server page, which keeps it 90 seconds and nothing more.
import { Track, type Room } from "livekit-client";
import type { MediaPath } from "./api.ts";

export interface Report {
  path: MediaPath;
  rttMs: number | null;
  lossPercent: number | null;
  sendKbps: number;
  receiveKbps: number;
  sending: string;
  browser: string;
}

type Stat = Record<string, unknown> & { type: string; id: string };

/** The path of the candidate pair in use, from one peer connection's stats. */
export function pathOf(stats: Map<string, Stat>): { path: MediaPath; rttMs: number | null } {
  const all = [...stats.values()];
  const transport = all.find((s) => s.type === "transport" && s.selectedCandidatePairId);
  const pair =
    (transport && stats.get(String(transport.selectedCandidatePairId))) ??
    all.find((s) => s.type === "candidate-pair" && (s.selected === true || (s.nominated === true && s.state === "succeeded")));
  if (!pair) return { path: "unknown", rttMs: null };
  const local = stats.get(String(pair.localCandidateId));
  const rtt = typeof pair.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null;
  if (!local) return { path: "unknown", rttMs: rtt };
  if (local.candidateType === "relay") {
    const via = String(local.relayProtocol ?? "udp").toLowerCase();
    return { path: via === "tls" ? "turn-tls" : via === "tcp" ? "turn-tcp" : "turn-udp", rttMs: rtt };
  }
  return { path: String(local.protocol).toLowerCase() === "tcp" ? "tcp" : "udp", rttMs: rtt };
}

/** Firefox 132, Chrome on Android, Safari on iPhone: enough to tell connections apart. */
export function browserName(ua: string = navigator.userAgent): string {
  const v = (re: RegExp) => re.exec(ua)?.[1]?.split(".")[0] ?? "";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : null;
  const name = /Edg\//.test(ua)
    ? `Edge ${v(/Edg\/([\d.]+)/)}`
    : /Firefox\//.test(ua)
      ? `Firefox ${v(/Firefox\/([\d.]+)/)}`
      : /Chrome\//.test(ua)
        ? `Chrome ${v(/Chrome\/([\d.]+)/)}`
        : /Safari\//.test(ua)
          ? `Safari ${v(/Version\/([\d.]+)/)}`
          : "Browser";
  return device ? `${name.split(" ")[0]} on ${device}` : name.trim();
}

/** Takes a report every call: the bytes since the last one make the rates. */
export function createReporter(room: Room) {
  let last: { at: number; sent: number; received: number } | null = null;
  return async (): Promise<Report> => {
    const reports: Array<Map<string, Stat>> = [];
    const local = [...room.localParticipant.trackPublications.values()].map((p) => p.track).filter((t) => !!t);
    const remote = [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].map((x) => x.track).filter((t) => !!t));
    for (const t of [...local, ...remote]) {
      const r = await t!.getRTCStatsReport().catch(() => undefined);
      if (r) reports.push(new Map(r as unknown as Iterable<[string, Stat]>));
    }
    let sent = 0;
    let received = 0;
    let lost = 0;
    let packets = 0;
    let path: { path: MediaPath; rttMs: number | null } = { path: "unknown", rttMs: null };
    let relayRtt: number | null = null;
    for (const r of reports) {
      const p = pathOf(r);
      if (path.path === "unknown" && p.path !== "unknown") path = p;
      for (const s of r.values()) {
        if (s.type === "outbound-rtp") sent += Number(s.bytesSent ?? 0);
        if (s.type === "inbound-rtp") {
          received += Number(s.bytesReceived ?? 0);
          lost += Math.max(0, Number(s.packetsLost ?? 0));
          packets += Number(s.packetsReceived ?? 0);
        }
        if (s.type === "remote-inbound-rtp" && typeof s.roundTripTime === "number") relayRtt = Math.round(s.roundTripTime * 1000);
      }
    }
    const now = performance.now();
    const secs = last ? (now - last.at) / 1000 : 0;
    const kbps = (bytes: number) => (secs > 0 ? Math.max(0, Math.round((bytes * 8) / 1000 / secs)) : 0);
    const out = {
      path: path.path,
      rttMs: path.rttMs ?? relayRtt,
      lossPercent: packets + lost > 0 ? Math.round((lost / (packets + lost)) * 1000) / 10 : null,
      sendKbps: last ? kbps(sent - last.sent) : 0,
      receiveKbps: last ? kbps(received - last.received) : 0,
      sending: sendingNow(room),
      browser: browserName(),
    };
    last = { at: now, sent, received };
    return out;
  };
}

/** What this browser sends, as a code the Server page words in the viewer's language: screen:1080p, camera:720p, audio or none. */
function sendingNow(room: Room): string {
  const lp = room.localParticipant;
  const screen = lp.getTrackPublication(Track.Source.ScreenShare);
  const camera = lp.getTrackPublication(Track.Source.Camera);
  const height = (pub: typeof screen) => (pub?.dimensions?.height ? `${pub.dimensions.height}p` : "");
  if (screen?.track && !screen.isMuted) return `screen:${height(screen)}`.replace(/:$/, "");
  if (camera?.track && !camera.isMuted) return `camera:${height(camera)}`.replace(/:$/, "");
  if (lp.isMicrophoneEnabled) return "audio";
  return "none";
}
