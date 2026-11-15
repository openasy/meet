// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  live: number;
  participants: { member: number; guest: number };
  lobby: number;
  recordings: Record<string, number>;
  /** 1 when LiveKit answered the last check (or none was made), 0 when it did not. */
  livekitUp: number;
  turn: Array<{ listener: string; up: number }>;
  counters: { tokens: Map<string, number>; lobby: Map<string, number>; recordings: Map<string, number>; webhooks: number };
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="meet",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_meet_live_meetings Meetings with a call open now.",
    "# TYPE openasy_meet_live_meetings gauge",
    `openasy_meet_live_meetings ${g.live}`,
    "# HELP openasy_meet_participants People in calls now, members and guests.",
    "# TYPE openasy_meet_participants gauge",
    `openasy_meet_participants{kind="member"} ${g.participants.member}`,
    `openasy_meet_participants{kind="guest"} ${g.participants.guest}`,
    "# HELP openasy_meet_lobby_waiting Guests waiting in a lobby.",
    "# TYPE openasy_meet_lobby_waiting gauge",
    `openasy_meet_lobby_waiting ${g.lobby}`,
    "# HELP openasy_meet_recordings Recordings, by state.",
    "# TYPE openasy_meet_recordings gauge",
    ...["recording", "saving", "ready", "failed"].map((s) => `openasy_meet_recordings{state="${s}"} ${g.recordings[s] ?? 0}`),
    "# HELP openasy_meet_livekit_up 1 when LiveKit answered the last check.",
    "# TYPE openasy_meet_livekit_up gauge",
    `openasy_meet_livekit_up ${g.livekitUp}`,
    "# HELP openasy_meet_turn_up 1 when the TURN listener answered the last check.",
    "# TYPE openasy_meet_turn_up gauge",
    ...g.turn.map((t) => `openasy_meet_turn_up{listener="${t.listener}"} ${t.up}`),
    "# HELP openasy_meet_tokens_total Access tokens given to browsers, by kind of person.",
    "# TYPE openasy_meet_tokens_total counter",
    ...[...g.counters.tokens].map(([k, n]) => `openasy_meet_tokens_total{kind="${k}"} ${n}`),
    "# HELP openasy_meet_lobby_total Knocks and answers in the lobby, by result.",
    "# TYPE openasy_meet_lobby_total counter",
    ...[...g.counters.lobby].map(([k, n]) => `openasy_meet_lobby_total{result="${k}"} ${n}`),
    "# HELP openasy_meet_recordings_total Recordings started, saved, failed and deleted.",
    "# TYPE openasy_meet_recordings_total counter",
    ...[...g.counters.recordings].map(([k, n]) => `openasy_meet_recordings_total{result="${k}"} ${n}`),
    "# HELP openasy_meet_webhooks_total Webhooks from LiveKit that were signed and read.",
    "# TYPE openasy_meet_webhooks_total counter",
    `openasy_meet_webhooks_total ${g.counters.webhooks}`,
    "# HELP openasy_meet_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_meet_config_error gauge",
    `openasy_meet_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
