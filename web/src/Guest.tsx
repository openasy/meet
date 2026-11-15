// A guest's way in: the meeting's link opened without an account. They give a name (and, if they like, an email), wait
// in the lobby until someone from the company lets them in, and join the call. Nothing else of them is asked or kept.
import { BrandMark, Button, Callout, EmptyState, PageHeader, Panel, TextField } from "@openasy/ui";
import { DoorOpen, LogIn, Video } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type JoinInfo, type LobbyStatus } from "./api.ts";
import { CallStage, LeftCall } from "./Call.tsx";
import { elapsed, shortLink, useNow } from "./common.tsx";
import { useT } from "./i18n.ts";
import type { Report } from "./stats.ts";

const VIDEO = "720p";
const key = (id: string) => `meet-ticket:${id}`;
const remember = (id: string, ticket: string | null) => {
  try {
    if (ticket) sessionStorage.setItem(key(id), ticket);
    else sessionStorage.removeItem(key(id));
  } catch {
    // Without storage, a reload asks to join again.
  }
};
const recall = (id: string) => {
  try {
    return sessionStorage.getItem(key(id));
  } catch {
    return null;
  }
};

export function GuestApp({ id, onSignIn }: { id: string; locale: string; onSignIn: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<JoinInfo | null>();
  const [ticket, setTicket] = useState<string | null>(() => recall(id));
  const [status, setStatus] = useState<LobbyStatus | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inCall, setInCall] = useState(false);
  const [left, setLeft] = useState<{ stillIn: string[]; recorded: boolean; reason: "left" | "removed" | "ended" } | null>(null);
  const [since] = useState(() => Date.now());
  const now = useNow();

  useEffect(() => {
    void api<JoinInfo>(`/api/v1/join/${id}`).then(setInfo, () => setInfo(null));
  }, [id]);

  // Waiting: ask every two seconds whether someone let them in.
  useEffect(() => {
    if (!ticket || inCall || left) return;
    let live = true;
    const ask = () =>
      void api<LobbyStatus>("/api/v1/lobby", { headers: { "x-lobby-ticket": ticket } }).then(
        (s) => {
          if (!live) return;
          setStatus(s);
          if (s.join) {
            setLeft(null);
            setInCall(true);
          }
        },
        (err) => {
          if (!live || !(err instanceof ApiError) || err.status !== 404) return;
          remember(id, null);
          setTicket(null);
          setStatus(null);
        },
      );
    ask();
    const timer = setInterval(ask, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ticket, inCall, left, id]);

  const knock = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ ticket: string } & LobbyStatus>(`/api/v1/join/${id}/lobby`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), ...(email.trim() && { email: email.trim() }) }),
      });
      remember(id, r.ticket);
      setTicket(r.ticket);
      setStatus({ ...r, join: null });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("loadFailed"));
    }
  };

  const stopWaiting = () => {
    if (ticket) void api("/api/v1/lobby", { method: "DELETE", headers: { "x-lobby-ticket": ticket } }).catch(() => {});
    remember(id, null);
    setTicket(null);
    setStatus(null);
  };

  const report = useCallback(
    (r: Report) =>
      ticket ? api<void>("/api/v1/lobby/stats", { method: "POST", headers: { "x-lobby-ticket": ticket }, body: JSON.stringify(r) }) : Promise.resolve(),
    [ticket],
  );
  const onLeft = useCallback((l: { stillIn: string[]; recorded: boolean; reason: "left" | "removed" | "ended" }) => {
    setInCall(false);
    setLeft(l);
  }, []);

  const org = info?.organization ?? t("common.theCompany");
  let body;
  if (info === null)
    body = (
      <EmptyState icon={<Video />} title={t("call.noSuchMeeting")}>
        {t("guest.noSuchMeeting")}
      </EmptyState>
    );
  else if (!info) body = <PageHeader title={t("loading")} />;
  else if (inCall && status?.join)
    body = (
      <CallStage
        access={status.join}
        camera
        mic
        title={info.title}
        description={`${t("call.organizer", { name: info.organizer })} · ${shortLink(window.location.href)}`}
        link={window.location.href}
        organization={info.organization}
        mediaHost={new URL(status.join.url).host}
        startedAt={null}
        video={VIDEO}
        organizer={false}
        recordingKnown={info.recording}
        notice={null}
        setNotice={() => {}}
        report={report}
        onLeft={onLeft}
      />
    );
  else if (left)
    body = (
      <LeftCall
        title={info.title}
        description={t("call.organizer", { name: info.organizer })}
        stillIn={left.stillIn}
        recorded={left.recorded}
        reason={left.reason}
        onRejoin={() => {
          setLeft(null);
          if (!ticket) setStatus(null);
        }}
      />
    );
  else
    body = (
      <>
        <PageHeader title={info.title} description={t("call.organizer", { name: info.organizer })} />
        <div className="meet-narrow flex flex-col gap-2.5">
          {(info.recording || status?.meeting.recording) && (
            <Callout tone="warning" title={t("call.recordingNow")}>
              {t("guest.recorded")}
            </Callout>
          )}
          {!info.guests ? (
            <Callout tone="info" title={t("guest.noGuests")}>
              {t("guest.noGuestsDetail", { organization: org })}
            </Callout>
          ) : !status ? (
            <Panel title={t("guest.askTitle")} description={t("guest.askDetail", { organization: org })}>
              <form onSubmit={(e) => void knock(e)} className="flex flex-col gap-2.5">
                <TextField label={t("guest.name")} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
                <TextField
                  label={t("guest.email")}
                  hint={t("guest.emailDetail")}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                  autoComplete="email"
                />
                {error && (
                  <p role="alert" className="text-xs text-danger-text">
                    {error}
                  </p>
                )}
                <p className="text-2xs text-fg-muted">{t("guest.kept")}</p>
                <span>
                  <Button type="submit" variant="primary" icon={<DoorOpen />} disabled={!name.trim()}>
                    {t("guest.ask")}
                  </Button>
                </span>
              </form>
            </Panel>
          ) : status.state === "waiting" || status.state === "admitted" ? (
            <Panel title={status.state === "admitted" ? t("guest.letInWaiting", { organization: org }) : t("guest.waiting")}>
              <div className="flex flex-col gap-2.5 text-sm text-fg">
                <p role="status">
                  {status.state === "admitted" ? t("guest.letInWaitingDetail", { organization: org }) : t("guest.waitingDetail", { organization: org })}
                </p>
                <p className="font-mono text-xs text-fg-muted tabular-nums">{elapsed(now - since)}</p>
                <span>
                  <Button size="sm" onClick={stopWaiting}>
                    {t("guest.stopWaiting")}
                  </Button>
                </span>
              </div>
            </Panel>
          ) : (
            <Panel title={status.state === "denied" ? t("guest.denied") : t("guest.expired")}>
              <div className="flex flex-col gap-2.5 text-sm text-fg">
                <p>{status.state === "denied" ? t("guest.deniedDetail") : t("guest.expiredDetail")}</p>
                <span>
                  <Button size="sm" onClick={stopWaiting}>
                    {t("guest.askAgain")}
                  </Button>
                </span>
              </div>
            </Panel>
          )}
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            {t("guest.haveAccount", { organization: org })}
            <Button size="xs" variant="ghost" icon={<LogIn />} onClick={onSignIn}>
              {t("guest.signIn")}
            </Button>
          </p>
        </div>
      </>
    );

  return (
    <div className="meet-guest flex min-h-screen flex-col gap-2.5 bg-canvas">
      <header className="flex items-center gap-2 text-sm font-semibold text-fg">
        <BrandMark product="meet" size={20} />
        {t("guest.product")}
      </header>
      <main className="flex flex-col gap-2.5">{body}</main>
    </div>
  );
}
