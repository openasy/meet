// A meeting's link, opened by someone signed in: a short look before going in, with camera and microphone chosen, and
// straight in when they came from the Join button.
import { Button, Callout, Checkbox, EmptyState, PageHeader, Panel, navigate } from "@openasy/ui";
import { Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import { ApiError, api, type Access, type JoinInfo, type Meeting } from "./api.ts";
import { post, shortLink } from "./common.tsx";
import { useT } from "./i18n.ts";

let autoJoin: string | null = null;
/** Opens a meeting and goes straight in: the click that led here lets the browser ask for the camera. */
export function openMeeting(id: string) {
  autoJoin = id;
  navigate(`/${id}`);
}

export function MeetingRoute({ call, id, startCall, me }: Ctx & { id: string }) {
  const t = useT();
  const [info, setInfo] = useState<JoinInfo | null>();
  // null: no problem; "": one the server gave no words for.
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(true);
  const [mic, setMic] = useState(true);

  const join = useCallback(
    async (withCamera: boolean, withMic: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const r = await call<Access & { meeting: Meeting }>(`/api/v1/meetings/${id}/join`, post());
        startCall({ id, access: { url: r.url, token: r.token, identity: r.identity }, meeting: r.meeting, camera: withCamera, mic: withMic, left: false });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "");
        setBusy(false);
      }
    },
    [call, id, startCall],
  );

  useEffect(() => {
    void api<JoinInfo>(`/api/v1/join/${id}`).then(setInfo, () => setInfo(null));
    if (autoJoin === id) {
      autoJoin = null;
      void join(true, true);
    }
  }, [id, join]);

  if (info === null)
    return (
      <EmptyState
        icon={<Video />}
        title={t("call.noSuchMeeting")}
        action={
          <Button onClick={() => navigate("/meetings")} size="sm">
            {t("call.backToMeetings")}
          </Button>
        }
      >
        {t("call.noSuchMeetingDetail")}
      </EmptyState>
    );
  if (!info) return <PageHeader title={t("loading")} />;
  return (
    <>
      <PageHeader title={info.title} description={`${t("call.organizer", { name: info.organizer })} · ${shortLink(`${window.location.origin}/${id}`)}`} />
      <div className="meet-narrow flex flex-col gap-2.5">
        {error !== null && (
          <Callout tone="danger" title={t("call.joinFailed")}>
            {error}
          </Callout>
        )}
        {info.recording && (
          <Callout tone="warning" title={t("call.recordingNow")}>
            {t("call.recordingNowDetail")}
          </Callout>
        )}
        <Panel title={t("call.beforeJoin")} description={t("call.beforeJoinDetail", { organization: me.organization ?? t("common.theCompany") })}>
          <div className="flex flex-col gap-2.5">
            <Checkbox label={t("call.withCamera")} checked={camera} onChange={(e) => setCamera(e.target.checked)} />
            <Checkbox label={t("call.withMic")} checked={mic} onChange={(e) => setMic(e.target.checked)} />
            <span>
              <Button variant="primary" icon={<Video />} disabled={busy} onClick={() => void join(camera, mic)}>
                {busy ? t("call.joining") : t("call.joinNow")}
              </Button>
            </span>
          </div>
        </Panel>
      </div>
    </>
  );
}
