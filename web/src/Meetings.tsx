// Today's meetings, how many joined, and a way into the next call: by the Join button, your own room, or a link.
import { useAuth } from "@openasy/auth/react";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  StatusBadge,
  Tabs,
  TextField,
  type Column,
  type Tone,
} from "@openasy/ui";
import { CalendarDays, CircleDot, Hash, Link2, Plus, Users, Video, DoorOpen } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Ctx } from "./App.tsx";
import { ApiError, type Meeting, type MeetingList, type MeetingStatus, type Source } from "./api.ts";
import { clock, dayLong, LinkBox, post, shortLink, useLoad } from "./common.tsx";
import { useT, type T } from "./i18n.ts";
import { openMeeting } from "./MeetingRoute.tsx";
import { codeOf } from "./links.ts";

const STATUS_TONE: Record<MeetingStatus, Tone> = { live: "success", upcoming: "info", ended: "neutral" };
const SOURCE_ICON: Record<Source, typeof CalendarDays> = { calendar: CalendarDays, chat: Hash, hand: Link2, room: DoorOpen };

/** Where a meeting's link came from: an icon, named for screen readers. */
function SourceIcon({ m, t }: { m: Meeting; t: T }) {
  const S = SOURCE_ICON[m.source];
  const label = t(`source.${m.source}`);
  const name = m.channel ? t("source.chatChannel", { channel: m.channel }) : label;
  return (
    <span title={name} className="flex shrink-0 items-center gap-0.5">
      <S aria-hidden className="size-3" />
      {m.channel ? <span className="font-medium">{m.channel}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

function StartDialog({ ctx, meeting, onClose }: { ctx: Ctx; meeting: Meeting | null; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [record, setRecord] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = ctx.me.recording;
  const org = ctx.me.organization ?? t("common.theCompany");
  const setRecording = async (on: boolean) => {
    if (!meeting) return;
    setRecord(on);
    try {
      await ctx.call(`/api/v1/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ allowRecording: on }) });
    } catch (err) {
      setRecord(!on);
      setError(err instanceof ApiError ? err.message : t("loadFailed"));
    }
  };
  return (
    <Dialog
      open={!!meeting}
      onOpenChange={(o) => {
        if (!o) onClose();
        setCopied(false);
      }}
      title={t("start.ready")}
      description={t("start.readyDetail", { organization: org })}
      icon={<Video className="size-4" />}
      iconTone="success"
      footer={
        <>
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" icon={<Video />} onClick={() => meeting && openMeeting(meeting.id)}>
            {t("start.open")}
          </Button>
        </>
      }
    >
      {meeting && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg">{t("start.link")}</span>
          <LinkBox link={meeting.url} label={t("start.copy")} onCopied={() => setCopied(true)} />
          {copied && (
            <p role="status" className="text-xs text-success">
              {t("start.copied")}
            </p>
          )}
        </div>
      )}
      <Checkbox
        label={t("start.allowRecording")}
        description={
          policy.allowed
            ? t("start.allowedFor", { group: policy.groupName })
            : policy.reason === "off"
              ? t("start.recordingOff")
              : policy.reason === "never"
                ? t("start.neverFor", { group: policy.groupName ?? "" })
                : t("start.notInGroup")
        }
        checked={record}
        disabled={!policy.allowed}
        onChange={(e) => void setRecording(e.target.checked)}
      />
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function MeetingsPage(ctx: Ctx) {
  const t = useT();
  const { can } = useAuth();
  const { call, me } = ctx;
  const [data, reload] = useLoad<MeetingList>(call, "/api/v1/meetings", 15_000);
  const [filter, setFilter] = useState<"all" | MeetingStatus>("all");
  const [started, setStarted] = useState<Meeting | null>(null);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [today] = useState(() => new Date().toISOString());

  const all = data?.meetings ?? [];
  const rows = all.filter((m) => filter === "all" || m.status === filter);
  const totals = data?.totals;
  const host = window.location.host;
  const mine = all.filter((m) => (m.you.organizer || m.you.invited) && m.status !== "ended" && m.source !== "room");

  const start = async () => {
    setBusy(true);
    try {
      setStarted(await call<Meeting>("/api/v1/meetings", post({ title: t("start.title", { name: me.member.name }) })));
      reload();
    } finally {
      setBusy(false);
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const code = codeOf(link);
    if (!code) return setLinkError(t("meetings.badLink"));
    setLinkError(null);
    openMeeting(code);
  };

  const cols: Column<Meeting>[] = [
    { id: "time", header: t("meetings.start"), width: "64px", mono: true, sortValue: (m) => m.at, cell: (m) => clock(m.at) },
    {
      id: "title",
      header: t("meetings.meeting"),
      width: "29%",
      sortValue: (m) => m.title,
      cell: (m) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{m.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-fg-muted">
            <SourceIcon m={m} t={t} />
            <span className="truncate font-mono">{shortLink(m.url)}</span>
            {m.recorded && (
              <span className="flex shrink-0 items-center gap-0.5 font-medium text-danger-text">
                <CircleDot aria-hidden className="size-3" />
                {t("meetings.recorded")}
              </span>
            )}
          </span>
        </span>
      ),
    },
    {
      id: "organizer",
      header: t("meetings.organizer"),
      sortValue: (m) => m.organizer.name,
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={m.organizer.name} size="sm" className="size-5" />
          <span className="truncate text-xs">{m.you.organizer ? t("meetings.you") : m.organizer.name}</span>
        </span>
      ),
    },
    {
      id: "people",
      header: t("meetings.joined"),
      description: t("meetings.joinedDetail"),
      sortValue: (m) => m.joined,
      cell: (m) => (
        <span className="flex items-center gap-1.5 text-xs whitespace-nowrap">
          <span className="tabular-nums">
            {m.status === "upcoming"
              ? m.invited !== null
                ? t("meetings.invitedN", { count: m.invited })
                : "–"
              : m.invited
                ? t("meetings.joinedOf", { joined: m.joined, invited: m.invited })
                : String(m.joined)}
          </span>
          {m.guests > 0 && <Badge>{t("meetings.guestsN", { count: m.guests })}</Badge>}
          {m.lobby ? <Badge tone="warning">{t("meetings.inLobby", { count: m.lobby })}</Badge> : null}
        </span>
      ),
    },
    {
      id: "status",
      header: t("meetings.status"),
      sortValue: (m) => m.minutes ?? 0,
      cell: (m) => (
        <span className="flex items-center gap-1.5 text-xs whitespace-nowrap">
          <StatusBadge tone={STATUS_TONE[m.status]}>{t(`status.${m.status}`)}</StatusBadge>
          {m.minutes !== null && <span className="text-fg-muted tabular-nums">{t("common.minutes", { count: m.minutes })}</span>}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("meetings.title")}
        description={`${dayLong(today)} · ${can("viewer") ? t("meetings.descriptionAll", { host }) : t("meetings.descriptionMine", { host })}`}
        actions={
          <Button variant="primary" icon={<Plus />} disabled={busy} onClick={() => void start()}>
            {t("meetings.startNow")}
          </Button>
        }
      />
      <KpiGrid minWidth={170}>
        <KpiCard
          label={t("meetings.today")}
          value={totals ? String(totals.meetings) : "–"}
          icon={Video}
          delta={{ label: totals ? t("meetings.liveAndToCome", { live: totals.live, upcoming: totals.upcoming }) : "" }}
        />
        <KpiCard
          label={t("meetings.peopleJoined")}
          value={totals ? String(totals.joined) : "–"}
          icon={Users}
          delta={{ label: totals ? t("meetings.guestsThroughLobby", { count: totals.guests }) : "" }}
        />
        <KpiCard
          label={t("meetings.averageLength")}
          value={totals?.averageMinutes !== null && totals?.averageMinutes !== undefined ? String(totals.averageMinutes) : "–"}
          unit={t("common.min")}
          delta={{ label: totals ? t("meetings.overEnded", { count: totals.ended }) : "" }}
        />
        <KpiCard
          label={t("meetings.recordedKpi")}
          value={totals ? String(totals.recorded) : "–"}
          icon={CircleDot}
          delta={{
            label: totals?.firstRecorded
              ? totals.firstRecorded.group
                ? t("meetings.recordedFor", { title: totals.firstRecorded.title, group: totals.firstRecorded.group })
                : totals.firstRecorded.title
              : t("meetings.noneRecorded"),
          }}
        />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_272px]">
        <Panel flush>
          <div className="px-3 pt-2">
            <Tabs
              label={t("meetings.byStatus")}
              value={filter}
              onChange={setFilter}
              items={[
                { value: "all", label: t("meetings.tabToday"), count: all.length },
                { value: "live", label: t("status.live"), count: totals?.live ?? 0 },
                { value: "upcoming", label: t("status.upcoming"), count: totals?.upcoming ?? 0 },
                { value: "ended", label: t("status.ended"), count: totals?.ended ?? 0 },
              ]}
              className="border-b-0"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("meetings.today")}
              columns={cols}
              rows={rows}
              getRowId={(m) => m.id}
              minWidth={760}
              loading={data === undefined}
              empty={data === null ? t("loadFailed") : t("meetings.none")}
            />
          </div>
        </Panel>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("meetings.next")}>
            {mine.length ? (
              <ul aria-label={t("meetings.nextList")} className="flex flex-col gap-2.5">
                {mine.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-fg">{m.title}</span>
                      <span className="text-xs text-fg-muted">
                        {m.status === "live"
                          ? t("meetings.startedInCall", { time: clock(m.startedAt ?? m.at), count: m.inCall.people })
                          : m.invited !== null
                            ? t("meetings.atInvited", { time: clock(m.at), count: m.invited })
                            : clock(m.at)}
                      </span>
                    </span>
                    {m.status === "live" ? (
                      <Button size="sm" variant="primary" icon={<Video />} onClick={() => openMeeting(m.id)}>
                        {t("meetings.join")}
                      </Button>
                    ) : (
                      <Badge>{clock(m.at)}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-fg-muted">{t("meetings.nothingNext")}</p>
            )}
          </Panel>
          {me.room && (
            <Panel title={t("meetings.room")} description={t("meetings.roomDetail")}>
              <div className="flex flex-col gap-2">
                <LinkBox link={me.room.url} label={t("meetings.copyRoom")} onCopied={() => setCopied(true)} small />
                {copied && (
                  <p role="status" className="text-xs text-success">
                    {t("meetings.roomCopied")}
                  </p>
                )}
                <p className="text-xs text-fg-muted">{t("meetings.roomGuests", { organization: me.organization ?? t("common.theCompany") })}</p>
                <span>
                  <Button size="sm" icon={<Video />} onClick={() => openMeeting(me.room!.id)}>
                    {t("meetings.openRoom")}
                  </Button>
                </span>
              </div>
            </Panel>
          )}
          <Panel title={t("meetings.joinWithLink")}>
            <form className="flex items-end gap-1.5" onSubmit={join}>
              <TextField
                label={t("meetings.linkOrCode")}
                placeholder={`${host}/abc-123-xyz`}
                value={link}
                onChange={(e) => setLink(e.target.value)}
                error={linkError ?? undefined}
                className="min-w-0 grow"
              />
              <Button type="submit">{t("meetings.join")}</Button>
            </form>
          </Panel>
        </div>
      </div>
      <StartDialog key={started?.id ?? "none"} ctx={ctx} meeting={started} onClose={() => setStarted(null)} />
    </>
  );
}
