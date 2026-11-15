// Integrations (LiveKit, its webhooks, Egress, its metrics, the identity provider's groups, TURN, and what Calendar
// and Chat call) and the read-only settings file.
import { Callout, PageHeader, Panel, StatusBadge } from "@openasy/ui";
import type { ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import type { Integrations, LinkState, Settings } from "./api.ts";
import { Code, num, useLoad, when } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

function LinkPanel({
  title,
  detail,
  link,
  off,
  example,
  children,
}: {
  title: string;
  detail: string;
  link: LinkState;
  off?: boolean;
  example?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const state = off ? "off" : link.ok === false ? "failing" : link.ok ? "ok" : "waiting";
  return (
    <Panel
      title={title}
      description={detail}
      actions={
        <StatusBadge tone={state === "ok" ? "success" : state === "failing" ? "danger" : state === "waiting" ? "warning" : "neutral"}>
          {t(`integrations.state.${state}`)}
        </StatusBadge>
      }
    >
      <div className="flex flex-col gap-1.5 text-xs text-fg-muted">
        {children}
        {link.at && link.ok && <span>{t("integrations.okAt", { when: when(link.at) })}</span>}
        {state === "failing" && link.error && <span className="text-danger-text">{link.error}</span>}
        {example && (off || state !== "ok") && <Code label={title}>{example}</Code>}
      </div>
    </Panel>
  );
}

export function IntegrationsPage({ call }: Ctx) {
  const t = useT();
  const [x] = useLoad<Integrations>(call, "/api/v1/integrations", 30_000);
  const origin = window.location.origin;
  if (!x) return <PageHeader title={t("integrations.title")} description={x === null ? t("loadFailed") : t("loading")} />;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="meet-halves grid gap-2.5">
        <LinkPanel
          title="LiveKit"
          detail={t("integrations.livekit")}
          link={x.livekit}
          example={`livekit:
  url: http://livekit:7880
  public_url: wss://rtc.example.com
  api_key: meet
  api_secret: MEET_LIVEKIT_SECRET`}
        >
          <span className="font-mono text-fg">{x.livekit.url}</span>
          <span>{t("integrations.browsers", { url: x.livekit.publicUrl })}</span>
          {!x.livekit.secret && <span className="text-danger-text">{t("integrations.noSecret")}</span>}
          {x.livekit.ok && <span>{t("integrations.rooms", { count: x.livekit.rooms })}</span>}
        </LinkPanel>
        <LinkPanel
          title={t("integrations.webhooks")}
          detail={t("integrations.webhooksDetail")}
          link={x.webhooks}
          example={`# livekit.yaml
webhook:
  api_key: meet
  urls:
    - ${x.webhooks.url}`}
        >
          {x.webhooks.count > 0 && <span>{t("integrations.webhooksSeen", { count: x.webhooks.count, last: x.webhooks.last ?? "" })}</span>}
        </LinkPanel>
        <LinkPanel
          title="Egress"
          detail={t("integrations.egress")}
          link={x.egress}
          off={!x.egress.on}
          example={`recording:
  allowed_for:
    - { group: leadership, keep_days: 90 }
  storage: /recordings`}
        >
          {x.egress.storage && <span>{t("integrations.storage", { path: x.egress.storage })}</span>}
        </LinkPanel>
        <LinkPanel
          title={t("integrations.metrics")}
          detail={t("integrations.metricsDetail")}
          link={x.metrics}
          off={!x.metrics.url}
          example={`# livekit.yaml
prometheus_port: 6789
# meet.yaml
livekit:
  metrics_url: http://livekit:6789/metrics`}
        >
          {x.metrics.url && <span className="font-mono text-fg">{x.metrics.url}</span>}
        </LinkPanel>
        <Panel title={t("integrations.groups")} description={t("integrations.groupsDetail")}>
          <div className="flex flex-col gap-1.5 text-xs text-fg-muted">
            <span>{t("integrations.fileGroups", { count: x.identity.fileGroups })}</span>
            <span>{t("integrations.idpGroups", { count: x.identity.peopleWithGroups })}</span>
            <Code label="OIDC">{`OPENASY_OIDC_SCOPES: openid email profile groups
OPENASY_OIDC_GROUPS_CLAIM: groups`}</Code>
          </div>
        </Panel>
        <Panel
          title="TURN"
          description={t("integrations.turn")}
          actions={
            x.turn.listeners ? (
              <StatusBadge tone={x.turn.reachable === x.turn.listeners ? "success" : "warning"}>
                {t("integrations.turnReachable", { reachable: num(x.turn.reachable), all: num(x.turn.listeners) })}
              </StatusBadge>
            ) : undefined
          }
        >
          <Code label="TURN">{`# livekit.yaml
turn:
  enabled: true
  domain: turn.example.com
  tls_port: 443
  udp_port: 3478`}</Code>
        </Panel>
        <Panel title={t("integrations.calendarChat")} description={t("integrations.calendarChatDetail")} className="meet-span2">
          <Code label={t("integrations.calendarChat")}>{`POST ${x.api.meetings}
Authorization: Bearer <a Meet token with the editor role>
{ "source": "calendar", "reference": "<the event's UID>", "title": "Interview",
  "organizer": { "email": "emily.clark@example.com" },
  "startsAt": "2026-11-05T10:30:00Z", "endsAt": "2026-11-05T11:30:00Z",
  "invited": ["candidate@example.net"] }

PATCH ${origin}/api/v1/meetings/{id}     when the event moves
DELETE ${origin}/api/v1/meetings/{id}    when it is cancelled`}</Code>
          <a href="/api/docs/" className="mt-2 block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
    </>
  );
}

export function SettingsFilePage({ settings }: { settings: Settings }) {
  const t = useT();
  const f = settings.file;
  const c = settings.config;
  const applied = f?.appliedAt ? when(f.appliedAt) : t("settings.notYet");
  const groups = Object.entries(c.groups);
  const name = (id: string) => c.groups[id]?.name ?? id;
  return (
    <FileSettingsPage
      file="meet.yaml"
      applied={applied}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="meet-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={[
        {
          title: "LiveKit",
          description: t("settings.livekitDetail"),
          items: [
            { label: t("settings.api"), value: <span className="font-mono">{c.livekit.url}</span>, path: "livekit.url" },
            { label: t("settings.browsers"), value: <span className="font-mono">{c.livekit.publicUrl}</span>, path: "livekit.public_url" },
            { label: t("settings.key"), value: t("settings.keyValue", { key: c.livekit.apiKey, variable: c.livekit.apiSecret }), path: "livekit.api_secret" },
            { label: t("settings.metrics"), value: c.livekit.metricsUrl ?? t("settings.none"), path: "livekit.metrics_url" },
          ],
        },
        {
          title: t("settings.limits"),
          items: [
            { label: t("settings.meetings"), value: t("settings.meetingsValue", { count: c.limits.meetings }), path: "limits.meetings" },
            { label: t("settings.people"), value: t("settings.peopleValue", { count: c.limits.people }), path: "limits.people" },
            { label: t("settings.video"), value: c.limits.video, path: "limits.video" },
            { label: t("settings.bandwidth"), value: c.limits.bandwidth ? `${num(c.limits.bandwidth)} Mbit/s` : t("settings.none"), path: "limits.bandwidth" },
          ],
        },
        {
          title: t("settings.lobby"),
          items: [
            { label: t("settings.guests"), value: c.lobby.guests ? t("settings.guestsOn") : t("settings.guestsOff"), path: "lobby.guests" },
            { label: t("settings.wait"), value: t("common.minutes", { count: c.lobby.waitMinutes }), path: "lobby.wait" },
          ],
        },
        {
          title: t("settings.recording"),
          description: t("settings.recordingDetail"),
          items: c.recording
            ? [
                ...c.recording.allowedFor.map((a) => ({
                  label: name(a.group),
                  value: t("settings.keptDays", { count: a.keepDays }),
                  path: `recording.allowed_for.${a.group}`,
                })),
                { label: t("settings.never"), value: c.recording.neverFor.map(name).join(", ") || t("settings.none"), path: "recording.never_for" },
                { label: t("settings.storage"), value: <span className="font-mono">{c.recording.storage}</span>, path: "recording.storage" },
              ]
            : [{ label: t("settings.recording"), value: t("settings.recordingOff"), path: "recording" }],
        },
        {
          title: t("settings.groups"),
          items: groups.length
            ? groups.map(([id, g]) => ({ label: g.name, value: t("settings.membersN", { count: g.members.length }), path: `groups.${id}` }))
            : [{ label: t("settings.groups"), value: t("settings.noGroups"), path: "groups" }],
        },
        {
          title: "TURN",
          items: c.turn.length
            ? c.turn.map((x, i) => ({
                label: `${x.transport.toUpperCase()} ${x.port}`,
                value: <span className="font-mono">{x.host}</span>,
                path: `turn[${i}]`,
              }))
            : [{ label: "TURN", value: t("settings.noTurn"), path: "turn" }],
        },
      ]}
    />
  );
}
