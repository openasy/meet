// The call itself: the shared screen, everyone's tile, the controls, and the people, the lobby and the chat beside it.
// Media goes between the browser and LiveKit only, with livekit-client; chat messages travel over LiveKit's data
// channel and are never stored, so they are gone when the call ends.
import { Avatar, Badge, Button, Callout, EmptyState, IconButton, PageHeader, Panel, StatusBadge, Tabs, TextField, cn, initials, navigate } from "@openasy/ui";
import { AudioLines, CircleDot, Copy, Hand, Mic, MicOff, MonitorUp, PhoneOff, Send, ShieldCheck, TriangleAlert, Video, VideoOff, Volume2 } from "lucide-react";
import {
  ConnectionQuality,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteParticipant,
  type Track as AnyTrack,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import { ApiError, type Access, type Meeting, type Waiting } from "./api.ts";
import { clock, copy, dayLong, elapsed, post, shortLink, useLoad, useNow } from "./common.tsx";
import { useT, viewerLocale, type T } from "./i18n.ts";
import { createReporter, type Report } from "./stats.ts";

export interface ActiveCall {
  id: string;
  access: Access;
  meeting: Meeting;
  camera: boolean;
  mic: boolean;
  left: boolean;
}

/** A person's tile colour, from the chart palette so it holds in both themes. */
type Hue = "chart-1" | "chart-2" | "chart-3" | "chart-4";
const HUES: Hue[] = ["chart-1", "chart-3", "chart-2", "chart-4"];
/** A tinted fill on the dark call stage. */
const onStage = (hue: Hue, strength: number): CSSProperties => ({
  backgroundColor: `color-mix(in oklab, var(--oa-${hue}) ${strength}%, var(--oa-topbar))`,
});

const PRESETS = { "360p": VideoPresets.h360, "540p": VideoPresets.h540, "720p": VideoPresets.h720, "1080p": VideoPresets.h1080 };
const CHAT_TOPIC = "meet-chat";

interface ChatLine {
  at: string;
  identity: string;
  from: string;
  text: string;
}

interface Who {
  kind: "member" | "guest";
  domain?: string;
}
const whoOf = (p: Participant): Who => {
  try {
    const m = JSON.parse(p.metadata || "{}") as Partial<Who>;
    return { kind: m.kind === "guest" ? "guest" : "member", ...(m.domain && { domain: m.domain }) };
  } catch {
    return { kind: "member" };
  }
};

/** Plays a remote participant's sound. */
function AudioTrack({ track }: { track: AnyTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => void track.detach(el);
  }, [track]);
  // A live call has no captions to give; the people in it are listed beside it.
  return (
    <audio ref={ref} autoPlay>
      <track kind="captions" />
    </audio>
  );
}

function VideoTrack({ track, mirror, fit = "cover" }: { track: AnyTrack; mirror?: boolean; fit?: "cover" | "contain" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => void track.detach(el);
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={cn("meet-video", fit === "contain" && "meet-video-contain", mirror && "meet-mirror")} />;
}

interface TileState {
  identity: string;
  name: string;
  you: boolean;
  guest: string | null;
  hue: Hue;
  muted: boolean;
  camera: AnyTrack | null;
  speaking: boolean;
  sharing: boolean;
  hand: boolean;
  weak: boolean;
}

function tileOf(p: Participant, i: number, you: boolean, t: T): TileState {
  const w = whoOf(p);
  const cam = p.getTrackPublication(Track.Source.Camera);
  return {
    identity: p.identity,
    name: p.name || p.identity,
    you,
    guest: w.kind === "guest" ? (w.domain ?? t("call.guest")) : null,
    hue: HUES[i % HUES.length]!,
    muted: !p.isMicrophoneEnabled,
    camera: cam?.track && !cam.isMuted ? cam.track : null,
    speaking: p.isSpeaking,
    sharing: p.isScreenShareEnabled,
    hand: p.attributes?.hand === "1",
    weak: p.connectionQuality === ConnectionQuality.Poor || p.connectionQuality === ConnectionQuality.Lost,
  };
}

function Tile({ p, t }: { p: TileState; t: T }) {
  return (
    <li
      className="relative grid min-h-0 place-items-center overflow-hidden rounded-lg"
      style={{ ...onStage(p.hue, p.camera ? 34 : 14), boxShadow: p.speaking ? "inset 0 0 0 3px var(--oa-chart-3)" : undefined }}
    >
      {p.camera ? (
        <VideoTrack track={p.camera} mirror={p.you} />
      ) : (
        <span aria-hidden className="grid size-12 place-items-center rounded-full text-xl font-semibold" style={onStage(p.hue, 40)}>
          {initials(p.name)}
        </span>
      )}
      <span className="absolute top-1.5 right-1.5 flex gap-1">
        {p.hand && (
          <span title={t("call.handRaised")} className="grid size-6 place-items-center rounded-full bg-warning-soft text-warning-text">
            <Hand aria-hidden className="size-3.5" />
          </span>
        )}
        {p.weak && (
          <span title={t("call.weak")} className="grid size-6 place-items-center rounded-full bg-warning-soft text-warning-text">
            <TriangleAlert aria-hidden className="size-3.5" />
          </span>
        )}
      </span>
      <span
        className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1 rounded px-1.5 py-0.5 text-xs"
        style={{ backgroundColor: "color-mix(in oklab, var(--oa-topbar) 82%, transparent)" }}
      >
        {p.muted ? (
          <MicOff aria-hidden className="size-3 shrink-0 text-danger-text" />
        ) : p.speaking ? (
          <AudioLines aria-hidden className="size-3 shrink-0" />
        ) : null}
        {!p.camera && <VideoOff aria-hidden className="oa-topbar-muted size-3 shrink-0" />}
        <span className="truncate">{p.you ? t("call.you", { name: p.name }) : p.name}</span>
        {p.guest && <span className="oa-topbar-muted shrink-0 text-2xs">{t("call.guest")}</span>}
        <span className="sr-only">
          {p.speaking && `, ${t("call.speaking")}`}
          {p.muted && `, ${t("call.muted")}`}
          {!p.camera && `, ${t("call.cameraOff")}`}
          {p.hand && `, ${t("call.handRaisedLower")}`}
          {p.weak && `, ${t("call.weakLower")}`}
        </span>
      </span>
    </li>
  );
}

function StageButton({
  icon,
  label,
  onClick,
  active,
  warn,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  warn?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="oa-topbar-button flex w-[76px] flex-col items-center gap-1 rounded-md py-1 text-2xs">
      <span
        className={cn("grid size-9 place-items-center rounded-full [&_svg]:size-4", warn && "bg-danger text-white", active && "bg-accent text-accent-contrast")}
        style={warn || active ? undefined : { backgroundColor: "var(--oa-topbar-hover)" }}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}

export interface StageProps {
  access: Access;
  camera: boolean;
  mic: boolean;
  title: string;
  description: string;
  link: string;
  organization: string | null;
  mediaHost: string | null;
  /** When the call started, for its clock; null counts from joining. */
  startedAt: string | null;
  video: keyof typeof PRESETS;
  /** The organiser's own name, for "(you, organiser)". */
  organizer: boolean;
  /** Members see the lobby and this meeting's details; guests do not. */
  lobby?: { waiting: Waiting[]; admit: (w: Waiting) => Promise<void>; deny: (w: Waiting) => Promise<void> } | null;
  details?: ReactNode;
  /** The Record button, for the organiser of a meeting that allows it. */
  record?: { toggle: () => Promise<void>; note: string } | null;
  recordingKnown: boolean;
  notice: { text: string; tone?: "danger" } | null;
  setNotice: (n: { text: string; tone?: "danger" } | null) => void;
  report: (r: Report) => Promise<void>;
  onLeft: (left: { stillIn: string[]; recorded: boolean; reason: "left" | "removed" | "ended" }) => void;
}

export function CallStage(s: StageProps) {
  const t = useT();
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "failed">("connecting");
  // "devices" when the camera or microphone could not be opened; otherwise why the connection failed.
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [side, setSide] = useState<"people" | "chat">("people");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [joinedAt] = useState(() => new Date().toISOString());
  const leaving = useRef(false);
  const now = useNow();
  const { access, camera, mic, video, report } = s;
  // The latest callback, without reconnecting the call when the page around it renders again.
  const onLeftRef = useRef(s.onLeft);
  onLeftRef.current = s.onLeft;

  useEffect(() => {
    const r = new Room({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: PRESETS[video].resolution } });
    const bump = () => setTick((n) => n + 1);
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.ParticipantMetadataChanged,
      RoomEvent.RecordingStatusChanged,
      RoomEvent.ConnectionQualityChanged,
      RoomEvent.AudioPlaybackStatusChanged,
      RoomEvent.Reconnecting,
      RoomEvent.Reconnected,
    ] as const;
    for (const e of events) r.on(e, bump);
    const onData = (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== CHAT_TOPIC || !p) return;
      try {
        const m = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
        if (typeof m.text === "string" && m.text.trim())
          setChat((c) => [...c, { at: new Date().toISOString(), identity: p.identity, from: p.name || p.identity, text: m.text as string }]);
      } catch {
        // Not one of ours.
      }
    };
    r.on(RoomEvent.DataReceived, onData);
    const onDisconnected = (reason?: DisconnectReason) => {
      if (leaving.current) return;
      const removed = reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.DUPLICATE_IDENTITY;
      onLeftRef.current({ stillIn: [], recorded: false, reason: removed ? "removed" : "ended" });
    };
    r.on(RoomEvent.Disconnected, onDisconnected);
    let cancelled = false;
    setRoom(r);
    void r.connect(access.url, access.token).then(
      async () => {
        if (cancelled) return;
        setState("connected");
        const problems: string[] = [];
        if (mic) await r.localParticipant.setMicrophoneEnabled(true).catch(() => problems.push("mic"));
        if (camera) await r.localParticipant.setCameraEnabled(true).catch(() => problems.push("camera"));
        if (problems.length && !cancelled) setError("devices");
        bump();
      },
      (err: Error) => {
        if (cancelled) return;
        setState("failed");
        setError(err.message);
      },
    );
    return () => {
      cancelled = true;
      for (const e of events) r.off(e, bump);
      r.off(RoomEvent.DataReceived, onData);
      r.off(RoomEvent.Disconnected, onDisconnected);
      void r.disconnect();
    };
  }, [access, camera, mic, video]);

  // How this browser connects, for the Server page, every 15 seconds.
  useEffect(() => {
    if (!room || state !== "connected") return;
    const take = createReporter(room);
    const send = () => void take().then(report, () => {});
    const first = setTimeout(send, 3000);
    const timer = setInterval(send, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [room, state, report]);

  const leave = useCallback(async () => {
    if (!room) return;
    const stillIn = [...room.remoteParticipants.values()].map((p) => p.name || p.identity);
    const recorded = room.isRecording;
    leaving.current = true;
    await room.disconnect();
    onLeftRef.current({ stillIn, recorded, reason: "left" });
  }, [room]);

  if (!room) return <PageHeader title={s.title} description={t("call.connecting")} />;
  const lp = room.localParticipant;
  const everyone: Participant[] = [lp, ...room.remoteParticipants.values()];
  const tiles = everyone.map((p, i) => tileOf(p, i, p === lp, t));
  const sharer = everyone.find((p) => p.isScreenShareEnabled);
  const screen = sharer?.getTrackPublication(Track.Source.ScreenShare)?.track ?? null;
  const audio = [...room.remoteParticipants.values()].flatMap((p) =>
    [Track.Source.Microphone, Track.Source.ScreenShareAudio].map((src) => p.getTrackPublication(src)?.track).filter((x): x is NonNullable<typeof x> => !!x),
  );
  const recording = room.isRecording || s.recordingKnown;
  const muted = !lp.isMicrophoneEnabled;
  const cameraOn = lp.isCameraEnabled;
  const hand = lp.attributes?.hand === "1";
  const lobby = s.lobby?.waiting ?? [];
  const startedAt = s.startedAt ?? joinedAt;
  const cols = Math.ceil(Math.sqrt(tiles.length));

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void lp.publishData(new TextEncoder().encode(JSON.stringify({ text })), { reliable: true, topic: CHAT_TOPIC });
    setChat((c) => [...c, { at: new Date().toISOString(), identity: lp.identity, from: lp.name || lp.identity, text }]);
    setDraft("");
  };
  const toggle = (work: () => Promise<unknown>) => () =>
    void work().then(
      () => setTick((n) => n + 1),
      (err: Error) => s.setNotice({ text: err.message, tone: "danger" }),
    );

  return (
    <>
      <PageHeader
        title={s.title}
        description={s.description}
        meta={
          <>
            <StatusBadge tone={state === "failed" ? "danger" : state === "connecting" ? "warning" : "success"}>
              {state === "failed" ? t("call.notConnected") : state === "connecting" ? t("call.connecting") : t("status.live")}
            </StatusBadge>
            {recording ? (
              <Badge tone="danger" icon={<CircleDot aria-hidden className="size-3" />}>
                {t("call.recording")}
              </Badge>
            ) : (
              <Badge>{t("call.notRecorded")}</Badge>
            )}
          </>
        }
        actions={
          <Button icon={<Copy />} size="sm" onClick={() => void copy(s.link).then(() => s.setNotice({ text: t("call.linkCopied") }))}>
            {t("call.copyLink")}
          </Button>
        }
      />
      {error && (
        <Callout tone={state === "failed" ? "danger" : "warning"} title={state === "failed" ? t("call.connectFailed") : t("call.devices")} className="mb-2.5">
          {error === "devices" ? t("call.noDevices") : error}
        </Callout>
      )}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_312px]">
        <section aria-label={t("call.stage")} className="oa-topbar flex h-[calc(100vh-12rem)] min-h-[580px] flex-col gap-2 rounded-lg p-2.5">
          <div className="flex items-center justify-between gap-2 px-1 text-xs">
            <span className="flex items-center gap-2">
              {sharer && (
                <>
                  <MonitorUp aria-hidden className="size-3.5" />
                  {sharer === lp ? t("call.youShare") : t("call.sharing", { name: sharer.name || sharer.identity })}
                </>
              )}
              {!room.canPlaybackAudio && (
                <Button size="xs" icon={<Volume2 />} onClick={() => void room.startAudio().then(() => setTick((n) => n + 1))}>
                  {t("call.startAudio")}
                </Button>
              )}
            </span>
            <span className="oa-topbar-muted flex items-center gap-3">
              {recording && (
                <span className="flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 font-medium text-white">
                  <CircleDot aria-hidden className="size-3" /> {t("call.recordingEveryone")}
                </span>
              )}
              {s.mediaHost && (
                <span className="flex items-center gap-1">
                  <ShieldCheck aria-hidden className="size-3.5" /> {t("call.mediaOnly", { host: s.mediaHost })}
                </span>
              )}
              <span className="font-mono tabular-nums">{elapsed(now - Date.parse(startedAt))}</span>
            </span>
          </div>
          {screen && sharer ? (
            <>
              <div className="min-h-0 grow">
                <div
                  role="img"
                  aria-label={t("call.screenOf", { name: sharer.name || sharer.identity })}
                  className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line bg-canvas"
                >
                  <VideoTrack track={screen} fit="contain" />
                </div>
              </div>
              <ul
                aria-label={t("call.participants")}
                className="grid h-[136px] shrink-0 gap-2"
                style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
              >
                {tiles.map((p) => (
                  <Tile key={p.identity} p={p} t={t} />
                ))}
              </ul>
            </>
          ) : (
            <ul
              aria-label={t("call.participants")}
              className="grid min-h-0 grow gap-2"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}
            >
              {tiles.map((p) => (
                <Tile key={p.identity} p={p} t={t} />
              ))}
            </ul>
          )}
          <div className="meet-audio" aria-hidden>
            {audio.map((a) => (
              <AudioTrack key={a.sid ?? a.mediaStreamTrack.id} track={a} />
            ))}
          </div>
          <div role="toolbar" aria-label={t("call.controls")} className="flex items-center justify-between gap-2 px-1">
            <span className="oa-topbar-muted w-40 text-xs">{t("call.inCall", { count: everyone.length })}</span>
            <span className="flex items-center gap-1">
              <StageButton
                icon={muted ? <MicOff /> : <Mic />}
                label={muted ? t("call.unmute") : t("call.mute")}
                warn={muted}
                disabled={state !== "connected"}
                onClick={toggle(() => lp.setMicrophoneEnabled(muted))}
              />
              <StageButton
                icon={cameraOn ? <Video /> : <VideoOff />}
                label={cameraOn ? t("call.stopVideo") : t("call.startVideo")}
                warn={!cameraOn}
                disabled={state !== "connected"}
                onClick={toggle(() => lp.setCameraEnabled(!cameraOn))}
              />
              <StageButton
                icon={<MonitorUp />}
                label={lp.isScreenShareEnabled ? t("call.stopShare") : t("call.share")}
                active={lp.isScreenShareEnabled}
                disabled={state !== "connected" || (!!sharer && sharer !== lp)}
                onClick={toggle(() => lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true }))}
              />
              <StageButton
                icon={<Hand />}
                label={hand ? t("call.lowerHand") : t("call.raiseHand")}
                active={hand}
                disabled={state !== "connected"}
                onClick={toggle(() => lp.setAttributes({ hand: hand ? "" : "1" }))}
              />
              {s.record && (
                <StageButton
                  icon={<CircleDot />}
                  label={recording ? t("call.stopRecording") : t("call.record")}
                  active={recording}
                  disabled={state !== "connected"}
                  onClick={toggle(s.record.toggle)}
                />
              )}
            </span>
            <span className="flex w-40 justify-end">
              <Button variant="danger" icon={<PhoneOff />} onClick={() => void leave()}>
                {t("call.leave")}
              </Button>
            </span>
          </div>
        </section>

        <Panel flush className="xl:h-[calc(100vh-12rem)] xl:min-h-[580px]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="px-3 pt-1">
              <Tabs
                label={t("call.beside")}
                value={side}
                onChange={setSide}
                items={[
                  { value: "people", label: t("call.people"), count: everyone.length + lobby.length },
                  { value: "chat", label: t("call.chat"), count: chat.length },
                ]}
              />
            </div>
            {s.notice && (
              <div
                role={s.notice.tone ? "alert" : "status"}
                className={cn("mx-3 mt-2.5 rounded-md px-2.5 py-1.5 text-xs text-fg", s.notice.tone ? "bg-danger-soft" : "bg-success-soft")}
              >
                {s.notice.text}
              </div>
            )}
            {side === "people" ? (
              <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-3">
                {lobby.length > 0 && (
                  <section className="flex flex-col gap-2 rounded-md border border-line bg-warning-soft p-2.5">
                    <h2 className="text-xs font-semibold text-fg">{t("call.lobby")}</h2>
                    <ul aria-label={t("call.lobbyList")} className="flex flex-col gap-2">
                      {lobby.map((x) => (
                        <li key={x.id} className="flex flex-col gap-1.5">
                          <span className="flex items-center gap-2">
                            <Avatar name={x.name} size="sm" />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-sm font-medium text-fg">{x.name}</span>
                              <span className="truncate text-2xs text-fg-muted">
                                {[x.email, t("call.waiting", { time: elapsed(now - Date.parse(x.since)) })].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                          </span>
                          <span className="flex gap-1">
                            <Button size="xs" variant="primary" onClick={() => void s.lobby?.admit(x)}>
                              {t("call.letIn")}
                            </Button>
                            <Button size="xs" onClick={() => void s.lobby?.deny(x)}>
                              {t("call.deny")}
                            </Button>
                          </span>
                          {x.invited && <span className="text-2xs text-fg-muted">{t("call.onInvitation")}</span>}
                        </li>
                      ))}
                    </ul>
                    <p className="text-2xs text-fg-muted">
                      {lobby.some((x) => !x.invited) ? `${t("call.notInvited")} ` : ""}
                      {t("call.guestsWhile", { organization: s.organization ?? t("common.theCompany") })}
                    </p>
                  </section>
                )}
                <section className="flex flex-col gap-1.5">
                  <h2 className="text-xs font-semibold text-fg-muted">{t("call.inTheCall")}</h2>
                  <ul aria-label={t("call.inTheCall")} className="flex flex-col gap-1.5">
                    {tiles.map((p) => (
                      <li key={p.identity} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar name={p.name} size="sm" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm text-fg">
                              {p.you ? (s.organizer ? t("call.youOrganizer", { name: p.name }) : t("call.you", { name: p.name })) : p.name}
                            </span>
                            <span className="truncate text-2xs text-fg-muted">
                              {p.guest
                                ? t("call.guestFrom", { from: p.guest })
                                : t("call.signedIn", { organization: s.organization ?? t("common.theCompany") })}
                              {p.sharing && ` · ${t("call.sharingShort")}`}
                            </span>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-fg-muted">
                          {p.hand && <Hand aria-label={t("call.handRaised")} className="size-3.5 text-warning-text" />}
                          {p.muted ? (
                            <MicOff aria-label={t("call.mutedTitle")} className="size-3.5 text-danger-text" />
                          ) : (
                            <Mic aria-label={t("call.micOn")} className="size-3.5" />
                          )}
                          {p.camera ? (
                            <Video aria-label={t("call.cameraOn")} className="size-3.5" />
                          ) : (
                            <VideoOff aria-label={t("call.cameraOffTitle")} className="size-3.5" />
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
                {s.details}
                {s.record && <p className="mt-auto rounded-md bg-canvas px-2.5 py-2 text-2xs text-fg-muted">{s.record.note}</p>}
              </div>
            ) : (
              <div className="flex min-h-0 grow flex-col">
                <ul aria-label={t("call.messages")} className="flex min-h-0 grow flex-col gap-2.5 overflow-y-auto p-3">
                  {chat.map((m, i) => (
                    <li key={i} className="flex gap-2">
                      <Avatar name={m.from} size="sm" />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-xs font-semibold text-fg">{m.identity === lp.identity ? t("call.youShort") : m.from}</span>
                          <span className="font-mono text-2xs text-fg-muted">{clock(m.at)}</span>
                        </span>
                        <span className="meet-wrap text-sm text-fg">{m.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="px-3 text-2xs text-fg-muted">{t("call.chatGone")}</p>
                <form onSubmit={send} className="flex items-end gap-1.5 p-3">
                  <TextField
                    label={<span className="sr-only">{t("call.message")}</span>}
                    placeholder={t("call.messagePlaceholder")}
                    value={draft}
                    maxLength={2000}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-w-0 grow"
                  />
                  <IconButton label={t("call.send")} type="submit" variant="primary" disabled={state !== "connected"}>
                    <Send className="size-4" />
                  </IconButton>
                </form>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

/** After leaving: who is still there, and what happens to the call. */
export function LeftCall({
  title,
  description,
  stillIn,
  recorded,
  reason,
  onRejoin,
  back,
}: {
  title: string;
  description: string;
  stillIn: string[];
  recorded: boolean;
  reason: "left" | "removed" | "ended";
  onRejoin: () => void;
  back?: ReactNode;
}) {
  const t = useT();
  const list = new Intl.ListFormat(viewerLocale(), { type: "conjunction" });
  return (
    <>
      <PageHeader title={title} description={description} />
      <Panel>
        <EmptyState
          icon={<PhoneOff />}
          title={reason === "removed" ? t("left.removed") : reason === "ended" ? t("left.ended") : t("left.title")}
          action={
            <span className="flex gap-1.5">
              <Button variant="primary" icon={<Video />} onClick={onRejoin}>
                {t("left.rejoin")}
              </Button>
              {back}
            </span>
          }
        >
          {[
            stillIn.length ? t(stillIn.length === 1 ? "left.stillInOne" : "left.stillIn", { names: list.format(stillIn) }) : "",
            recorded ? t("left.recorded") : t("left.notKept"),
          ]
            .filter(Boolean)
            .join(" ")}
        </EmptyState>
      </Panel>
    </>
  );
}

const sourceLabel = (m: Meeting, t: T) => (m.source === "chat" && m.channel ? t("source.chatChannel", { channel: m.channel }) : t(`source.${m.source}Long`));

/** A signed-in member's call: the stage with the lobby, this meeting's details and the Record button. */
export function CallView({ call, me, active, onLeft, startCall }: Ctx & { active: ActiveCall; onLeft: () => void }) {
  const t = useT();
  const id = active.id;
  const [meeting, reloadMeeting] = useLoad<Meeting>(call, `/api/v1/meetings/${id}`, 10_000);
  const m = meeting ?? active.meeting;
  const [lobby, setLobby] = useState<Waiting[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const [left, setLeft] = useState<{ stillIn: string[]; recorded: boolean; reason: "left" | "removed" | "ended" } | null>(null);

  // Who waits in the lobby, every few seconds, while in the call; only the organiser and people in the call see it.
  useEffect(() => {
    if (left) return;
    let live = true;
    const load = () =>
      void call<{ waiting: Waiting[] }>(`/api/v1/meetings/${id}/lobby`).then(
        (r) => live && setLobby(r.waiting),
        () => live && setLobby(null),
      );
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [call, id, left]);

  const decide = (admit: boolean) => async (w: Waiting) => {
    try {
      await call(`/api/v1/meetings/${id}/lobby/${w.id}/${admit ? "admit" : "deny"}`, post());
      setLobby((l) => l?.filter((x) => x.id !== w.id) ?? null);
      setNotice({ text: admit ? t("call.admitted", { name: w.name }) : t("call.denied", { name: w.name }) });
      reloadMeeting();
    } catch (err) {
      setNotice({ text: err instanceof ApiError ? err.message : t("loadFailed"), tone: "danger" });
    }
  };

  const report = useCallback((r: Report) => call<void>(`/api/v1/meetings/${id}/stats`, post(r)), [call, id]);
  const handleLeft = useCallback(
    (l: { stillIn: string[]; recorded: boolean; reason: "left" | "removed" | "ended" }) => {
      setLeft(l);
      onLeft();
    },
    [onLeft],
  );

  const span =
    m.startsAt && m.endsAt ? t("call.span", { from: clock(m.startsAt), to: clock(m.endsAt) }) : t("call.since", { time: clock(m.startedAt ?? m.createdAt) });
  const description = `${dayLong(m.startedAt ?? m.startsAt ?? m.createdAt)} · ${span} · ${shortLink(m.url)}`;
  const policy = me.recording;
  const canRecord = m.you.organizer && m.allowRecording && policy.allowed;

  if (left)
    return (
      <LeftCall
        title={m.title}
        description={description}
        stillIn={left.stillIn}
        recorded={left.recorded || m.recording}
        reason={left.reason}
        onRejoin={() => {
          void call<Access & { meeting: Meeting }>(`/api/v1/meetings/${id}/join`, post()).then(
            (r) => startCall({ ...active, access: { url: r.url, token: r.token, identity: r.identity }, meeting: r.meeting, left: false }),
            (err: Error) => setNotice({ text: err.message, tone: "danger" }),
          );
        }}
        back={<Button onClick={() => navigate("/meetings")}>{t("call.backToMeetings")}</Button>}
      />
    );

  return (
    <CallStage
      access={active.access}
      camera={active.camera}
      mic={active.mic}
      title={m.title}
      description={description}
      link={m.url}
      organization={me.organization}
      mediaHost={me.media.host}
      startedAt={m.startedAt}
      video={me.limits.video}
      organizer={m.you.organizer}
      lobby={lobby ? { waiting: lobby, admit: decide(true), deny: decide(false) } : null}
      recordingKnown={m.recording}
      record={
        canRecord
          ? {
              note: t("call.recordNote", { group: policy.allowed ? policy.groupName : "" }),
              toggle: async () => {
                await call(`/api/v1/meetings/${id}/recording`, { method: m.recording ? "DELETE" : "POST" });
                reloadMeeting();
              },
            }
          : null
      }
      notice={notice}
      setNotice={setNotice}
      report={report}
      onLeft={handleLeft}
      details={
        <section className="flex flex-col gap-1.5 border-t border-line pt-3">
          <h2 className="text-xs font-semibold text-fg-muted">{t("call.thisMeeting")}</h2>
          <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <dt className="text-fg-muted">{t("call.linkFrom")}</dt>
            <dd className="text-fg">
              {t("call.madeOn", { source: sourceLabel(m, t), day: new Date(m.createdAt).toLocaleDateString(viewerLocale(), { weekday: "long" }) })}
            </dd>
            <dt className="text-fg-muted">{t("call.invited")}</dt>
            <dd className="text-fg">{m.invited === null ? t("call.noInvitation") : t("call.invitedCount", { count: m.invited })}</dd>
            <dt className="text-fg-muted">{t("call.guests")}</dt>
            <dd className="text-fg">{m.admitted ? t("call.letInBy", { name: m.admitted.by, time: clock(m.admitted.at) }) : t("call.noGuests")}</dd>
            <dt className="text-fg-muted">{t("call.media")}</dt>
            <dd className="text-fg">{t("call.mediaPaths", { direct: m.media.direct, relayed: m.media.relayed })}</dd>
          </dl>
        </section>
      }
    />
  );
}
