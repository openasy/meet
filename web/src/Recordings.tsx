// The few meetings that were recorded, who saw that they were, and when each file goes.
import { Avatar, Badge, Button, DataTable, Dialog, IconButton, KpiCard, KpiGrid, PageHeader, Panel, SearchInput, StatusBadge, type Column } from "@openasy/ui";
import { CircleDot, Download, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import { ApiError, type Recording, type RecordingList } from "./api.ts";
import { Notice, dayMonth, dayShort, gb, length, useLoad, when } from "./common.tsx";
import { useT, viewerLocale } from "./i18n.ts";

export function RecordingsPage({ call, me }: Ctx) {
  const t = useT();
  const [data, reload] = useLoad<RecordingList>(call, "/api/v1/recordings", 30_000);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const items = data?.recordings ?? [];
  const rows = items.filter((r) => `${r.title} ${r.startedBy.name}`.toLowerCase().includes(query.toLowerCase()));
  const cur = items.find((r) => r.id === active) ?? items[0];
  const totals = data?.totals;
  const policy = data?.policy;
  const soon = (r: Recording) => !!r.deleteOn && Date.parse(r.deleteOn) - Date.now() < 7 * 24 * 3600_000;
  const list = new Intl.ListFormat(viewerLocale(), { type: "conjunction" });
  const you = (name: string, email: string) => (email === me.member.email ? t("meetings.you") : name);

  const remove = async () => {
    if (!cur) return;
    setConfirm(false);
    try {
      await call(`/api/v1/recordings/${cur.id}`, { method: "DELETE" });
      setNotice({ text: t("recordings.deleted", { title: cur.title, date: when(cur.startedAt) }) });
      setActive(items.find((x) => x.id !== cur.id)?.id ?? null);
      reload();
    } catch (err) {
      setNotice({ text: err instanceof ApiError ? err.message : t("loadFailed"), tone: "danger" });
    }
  };

  const cols: Column<Recording>[] = [
    {
      id: "title",
      header: t("recordings.meeting"),
      width: "30%",
      sortValue: (r) => r.title,
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.title}</span>
          <span className="truncate text-2xs text-fg-muted">{when(r.startedAt)}</span>
        </span>
      ),
    },
    {
      id: "by",
      header: t("recordings.startedBy"),
      sortValue: (r) => r.startedBy.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={r.startedBy.name} size="sm" className="size-5" />
          <span className="truncate text-xs">{you(r.startedBy.name, r.startedBy.email)}</span>
        </span>
      ),
    },
    { id: "group", header: t("recordings.allowedFor"), cell: (r) => <Badge tone="info">{r.group.name}</Badge> },
    {
      id: "length",
      header: t("recordings.length"),
      align: "right",
      mono: true,
      sortValue: (r) => r.seconds,
      cell: (r) =>
        r.state === "ready" ? (
          length(Math.round(r.seconds / 60), t)
        ) : (
          <StatusBadge tone={r.state === "failed" ? "danger" : "warning"}>{t(`recordings.state.${r.state}`)}</StatusBadge>
        ),
    },
    { id: "size", header: t("recordings.size"), align: "right", mono: true, sortValue: (r) => r.size, cell: (r) => (r.size ? `${gb(r.size)} GB` : "–") },
    {
      id: "kept",
      header: t("recordings.deletedOn"),
      sortValue: (r) => r.deleteOn ?? "",
      cell: (r) =>
        !r.deleteOn ? "–" : soon(r) ? <Badge tone="warning">{dayShort(r.deleteOn)}</Badge> : <span className="text-xs">{dayShort(r.deleteOn)}</span>,
    },
  ];

  return (
    <>
      <PageHeader title={t("recordings.title")} description={t("recordings.description")} />
      {notice && (
        <Notice tone={notice.tone} className="mb-2.5">
          {notice.text}
        </Notice>
      )}
      <KpiGrid minWidth={170}>
        <KpiCard
          label={t("recordings.kept")}
          value={totals ? String(totals.kept) : "–"}
          icon={CircleDot}
          delta={{ label: totals ? t("recordings.ofMeetings", { count: totals.meetingsLast30Days }) : "" }}
        />
        <KpiCard
          label={t("recordings.storage")}
          value={totals ? gb(totals.bytes) : "–"}
          unit="GB"
          delta={{ label: totals?.capacity ? t("recordings.ofDisk", { size: gb(totals.capacity) }) : t("recordings.diskUnknown") }}
        />
        <KpiCard
          label={t("recordings.nextDeletion")}
          value={totals?.nextDeletion ? dayMonth(totals.nextDeletion.on) : "–"}
          delta={{
            label: totals?.nextDeletion
              ? t("recordings.afterDays", { title: totals.nextDeletion.title, count: totals.nextDeletion.keepDays })
              : t("recordings.nothingDue"),
          }}
        />
        <KpiCard
          label={t("recordings.whoMay")}
          value={policy ? String(policy.groups.length) : "–"}
          unit={t("recordings.groupsUnit", { count: policy?.groups.length ?? 0 })}
          delta={{ label: policy?.on ? list.format(policy.groups.map((g) => g.name)) : t("recordings.off") }}
        />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title={t("recordings.list")}
          flush
          actions={
            <SearchInput
              label={t("recordings.search")}
              placeholder={t("recordings.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-56"
            />
          }
        >
          <DataTable
            label={t("recordings.title")}
            columns={cols}
            rows={rows}
            getRowId={(r) => r.id}
            onRowClick={(r) => setActive(r.id)}
            activeRowId={cur?.id}
            minWidth={720}
            loading={data === undefined}
            empty={data === null ? t("loadFailed") : t("recordings.none")}
          />
        </Panel>
        <div className="flex flex-col gap-2.5">
          {cur && (
            <Panel
              aria-label={t("recordings.one")}
              title={cur.title}
              description={[when(cur.startedAt), cur.state === "ready" && length(Math.round(cur.seconds / 60), t), cur.size > 0 && `${gb(cur.size)} GB`]
                .filter(Boolean)
                .join(" · ")}
              actions={
                <>
                  {cur.state === "ready" && (
                    <a
                      href={`/api/v1/recordings/${cur.id}/file`}
                      download
                      aria-label={t("recordings.download")}
                      title={t("recordings.download")}
                      className="inline-grid size-7 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg"
                    >
                      <Download aria-hidden className="size-3.5" />
                    </a>
                  )}
                  {cur.canDelete && cur.state !== "recording" && (
                    <IconButton label={t("recordings.delete")} size="sm" onClick={() => setConfirm(true)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  )}
                </>
              }
            >
              <div className="flex flex-col gap-3 text-sm">
                <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
                  <dt className="text-fg-muted">{t("recordings.startedBy")}</dt>
                  <dd className="text-fg">{t("recordings.organizerAt", { name: cur.startedBy.name })}</dd>
                  <dt className="text-fg-muted">{t("recordings.allowedBy")}</dt>
                  <dd className="text-fg">{t("recordings.groupKept", { group: cur.group.name, count: cur.group.keepDays })}</dd>
                  <dt className="text-fg-muted">{t("recordings.deletedOn")}</dt>
                  <dd className="text-fg">{cur.deleteOn ? dayShort(cur.deleteOn) : t(`recordings.state.${cur.state}`)}</dd>
                  <dt className="text-fg-muted">{t("recordings.file")}</dt>
                  <dd className="font-mono break-all text-fg">{cur.file}</dd>
                  {cur.error && (
                    <>
                      <dt className="text-fg-muted">{t("recordings.problem")}</dt>
                      <dd className="text-danger-text">{cur.error}</dd>
                    </>
                  )}
                </dl>
                <section className="flex flex-col gap-1.5 border-t border-line pt-3">
                  <h3 className="text-xs font-semibold text-fg-muted">
                    {t("recordings.saw", { seen: cur.people.length + cur.guests, all: cur.people.length + cur.guests })}
                  </h3>
                  <ul aria-label={t("recordings.people")} className="flex flex-wrap gap-1">
                    {cur.people.map((p, i) => (
                      <li key={`${p}-${i}`}>
                        <Badge icon={<Avatar name={p} size="sm" className="size-4 text-[9px]" />}>{p}</Badge>
                      </li>
                    ))}
                    {cur.guests > 0 && (
                      <li>
                        <Badge>{t("recordings.guestsTold", { count: cur.guests })}</Badge>
                      </li>
                    )}
                  </ul>
                </section>
              </div>
            </Panel>
          )}
          <Panel title={t("recordings.whoMay")} description={t("recordings.fromFile")}>
            <pre className="overflow-x-auto rounded-md bg-canvas p-2.5 font-mono text-2xs leading-relaxed text-fg">{policy?.yaml ?? ""}</pre>
          </Panel>
        </div>
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("recordings.deleteTitle", { title: cur?.title ?? "" })}
        description={t("recordings.deleteDetail")}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t("recordings.deleteButton")}
            </Button>
          </>
        }
      />
    </>
  );
}
