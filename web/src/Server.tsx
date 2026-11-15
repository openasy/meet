// For IT: what LiveKit carries, whether TURN answers, and how each person connects.
import { Avatar, DataTable, KpiCard, KpiGrid, PageHeader, Panel, StatusBadge, TimeSeriesChart, cn, type Column, type Tone } from "@openasy/ui";
import { ShieldCheck, ShieldX, Users, Video } from "lucide-react";
import type { Ctx } from "./App.tsx";
import type { Connection, MediaPath, ServerState } from "./api.ts";
import { clock, num, pct, useLoad, useNow } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

const PATH_TONE: Record<MediaPath, Tone> = {
  udp: "success",
  tcp: "info",
  "turn-udp": "info",
  "turn-tcp": "warning",
  "turn-tls": "warning",
  unknown: "neutral",
};

/** What a browser sends, as the stats name it: camera:720p, screen:1080p, audio or none. */
export function sendingLabel(s: string, t: T): string {
  const [kind, res] = s.split(":");
  if (kind === "screen") return res ? t("server.sendScreen", { res }) : t("server.sendScreenOnly");
  if (kind === "camera") return res ?? t("server.sendVideo");
  if (kind === "audio") return t("server.sendAudio");
  if (kind === "none") return t("server.sendNothing");
  return s || "–";
}

export function ServerPage({ call }: Ctx) {
  const t = useT();
  const [s] = useLoad<ServerState>(call, "/api/v1/server", 15_000);
  const now = useNow(60_000);
  if (s === undefined) return <PageHeader title={t("server.title")} description={t("loading")} />;
  if (s === null) return <PageHeader title={t("server.title")} description={t("loadFailed")} />;
  const lk = s.livekit;
  const relayed = s.connections.filter((c) => c.path.startsWith("turn"));
  const mediaHost = URL.parse(lk.publicUrl)?.host ?? lk.publicUrl;
  const turnHosts = [...new Set(s.turn.map((x) => x.host))];
  const healthy = lk.ok !== false;
  const days = lk.startedAt ? Math.max(0, Math.floor((now - Date.parse(lk.startedAt)) / 86_400_000)) : null;
  const turnOk = s.turn.length > 0 && s.turn.every((x) => x.ok);
  const checkedAt = s.turn.find((x) => x.at)?.at;

  const cols: Column<Connection>[] = [
    {
      id: "name",
      header: t("server.person"),
      width: "20%",
      sortValue: (c) => c.name,
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={c.name} size="sm" className="size-5" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium">{c.name}</span>
            <span className="truncate text-2xs text-fg-muted">{c.guest ? t("call.guest") : t("server.member")}</span>
          </span>
        </span>
      ),
    },
    { id: "meeting", header: t("server.meeting"), sortValue: (c) => c.meeting, cell: (c) => <span className="truncate text-xs">{c.meeting}</span> },
    { id: "path", header: t("server.path"), sortValue: (c) => c.path, cell: (c) => <StatusBadge tone={PATH_TONE[c.path]}>{t(`path.${c.path}`)}</StatusBadge> },
    { id: "browser", header: t("server.browser"), cell: (c) => <span className="truncate text-xs">{c.browser || "–"}</span> },
    {
      id: "rtt",
      header: t("server.rtt"),
      align: "right",
      mono: true,
      sortValue: (c) => c.rttMs ?? 0,
      cell: (c) => (c.rttMs === null ? "–" : `${num(c.rttMs)} ms`),
    },
    {
      id: "loss",
      header: t("server.loss"),
      align: "right",
      mono: true,
      sortValue: (c) => c.lossPercent ?? 0,
      cell: (c) => (c.lossPercent === null ? "–" : <span className={cn(c.lossPercent >= 2 && "font-semibold text-warning-text")}>{pct(c.lossPercent)}</span>),
    },
    { id: "video", header: t("server.sending"), cell: (c) => <span className="text-xs">{sendingLabel(c.sending, t)}</span> },
  ];

  return (
    <>
      <PageHeader
        title={t("server.title")}
        description={
          turnHosts.length ? t("server.description", { media: mediaHost, turn: turnHosts.join(", ") }) : t("server.descriptionNoTurn", { media: mediaHost })
        }
        meta={
          <StatusBadge tone={lk.ok === null ? "neutral" : healthy ? "success" : "danger"}>
            {t(lk.ok === null ? "server.notChecked" : healthy ? "server.healthy" : "server.unreachable")}
          </StatusBadge>
        }
      />
      <KpiGrid minWidth={170}>
        <KpiCard label={t("server.live")} value={String(s.live.meetings)} icon={Video} delta={{ label: t("server.upTo", { count: s.limits.meetings }) }} />
        <KpiCard label={t("server.people")} value={String(s.live.people)} icon={Users} delta={{ label: t("server.inLobby", { count: s.live.lobby }) }} />
        <KpiCard
          label={t("server.bandwidth")}
          value={num(s.bandwidth.nowMbps, 1)}
          unit="Mbit/s"
          delta={{ label: s.bandwidth.capacityMbps ? t("server.ofCapacity", { capacity: num(s.bandwidth.capacityMbps) }) : t("server.noCapacity") }}
        />
        <KpiCard
          label={t("server.relayed")}
          value={t("server.relayedValue", { relayed: relayed.length, all: s.connections.length })}
          delta={{ label: relayed[0] ? t("server.relayedWho", { name: relayed[0].name, path: t(`path.${relayed[0].path}`) }) : t("server.relayedNone") }}
        />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px_300px]">
        <Panel title={t("server.chartTitle")} description={t("server.chartDetail")}>
          <TimeSeriesChart
            label={t("server.chartLabel")}
            labels={s.bandwidth.samples.map((x) => clock(x.at))}
            height={190}
            area
            format={(v) => `${num(v, 1)} Mbit/s`}
            series={[
              { id: "all", name: t("server.allMedia"), data: s.bandwidth.samples.map((x) => x.totalMbps), color: "var(--oa-chart-1)" },
              { id: "turn", name: t("server.throughTurn"), data: s.bandwidth.samples.map((x) => x.relayedMbps), color: "var(--oa-chart-2)" },
            ]}
          />
        </Panel>
        <Panel title={t("server.mediaServer")} description={lk.url}>
          <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
            <dt className="text-fg-muted">{t("server.signalling")}</dt>
            <dd className="font-mono break-all text-fg">{lk.publicUrl}</dd>
            <dt className="text-fg-muted">{t("server.mediaPorts")}</dt>
            <dd className="text-fg">{lk.mediaPorts ?? t("server.notInFile")}</dd>
            <dt className="text-fg-muted">CPU</dt>
            <dd className="text-fg">
              {lk.cpuPercent === null
                ? t("server.noMetrics")
                : lk.cores
                  ? t("server.cpuOf", { percent: pct(lk.cpuPercent, 0), cores: num(lk.cores) })
                  : pct(lk.cpuPercent, 0)}
            </dd>
            <dt className="text-fg-muted">{t("server.memory")}</dt>
            <dd className="text-fg">{lk.memoryBytes === null ? t("server.noMetrics") : `${num(lk.memoryBytes / 1024 ** 3, 1)} GB`}</dd>
            <dt className="text-fg-muted">{t("server.perMeeting")}</dt>
            <dd className="text-fg">{t("server.perMeetingValue", { people: s.limits.people, video: s.limits.video })}</dd>
            <dt className="text-fg-muted">{t("server.runningFor")}</dt>
            <dd className="text-fg">{days === null ? t("server.noMetrics") : t("server.days", { count: days })}</dd>
            <dt className="text-fg-muted">{t("server.answered")}</dt>
            <dd className={cn("text-fg", lk.ok === false && "text-danger-text")}>
              {lk.ok === false ? lk.error : lk.ms !== null && lk.at ? t("server.answeredIn", { ms: num(lk.ms), time: clock(lk.at), rooms: lk.rooms }) : "–"}
            </dd>
          </dl>
        </Panel>
        <Panel
          title="TURN"
          description={checkedAt ? t("server.turnChecked", { time: clock(checkedAt) }) : t("server.turnNotChecked")}
          actions={
            s.turn.length ? (
              <StatusBadge tone={turnOk ? "success" : "warning"}>{turnOk ? t("server.reachable") : t("server.notReachable")}</StatusBadge>
            ) : undefined
          }
        >
          {s.turn.length ? (
            <ul aria-label={t("server.turnListeners")} className="flex flex-col gap-2">
              {s.turn.map((x) => (
                <li key={`${x.transport}-${x.host}-${x.port}`} className="flex items-start gap-2">
                  {x.ok === false ? (
                    <ShieldX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger-text" />
                  ) : (
                    <ShieldCheck aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", x.ok ? "text-success" : "text-fg-muted")} />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono text-xs text-fg">
                      {x.host}, {x.transport.toUpperCase()} {x.port}
                    </span>
                    <span className="text-2xs text-fg-muted">{x.ok === false ? x.error : t(`server.turn.${x.transport}`)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted">{t("server.noTurn")}</p>
          )}
          <p className="mt-3 border-t border-line pt-2.5 text-2xs text-fg-muted">{t("server.turnCredentials")}</p>
        </Panel>
      </div>
      <Panel title={t("server.connections")} flush>
        <DataTable
          label={t("server.connections")}
          columns={cols}
          rows={s.connections}
          getRowId={(c) => c.identity}
          defaultSort={{ id: "meeting", direction: "asc" }}
          minWidth={900}
          empty={t("server.noConnections")}
        />
      </Panel>
    </>
  );
}
