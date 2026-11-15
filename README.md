# meet

[![CI](https://github.com/openasy/meet/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/meet/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Meet product: video meetings in the browser, with screen sharing, a lobby
for guests and recordings only where a file allows them, kept in your install. The calls run on
[LiveKit](https://livekit.io), the open-source media server (Apache 2.0): it carries every call's audio, video and
shared screens, and its Egress records a room when asked. Meet writes the pages, the links, the lobby, the access
tokens and the rules around them; it never carries media itself.

```
meet.yaml ──▶ meet ── Twirp API (rooms, participants, Egress) ──▶ LiveKit ◀── WebRTC, TURN ── browsers
               ▲  ▲                                                │   │
  the pages ───┘  └──────────── webhooks, signed ──────────────────┘   └── Egress ──▶ /recordings (MP4)
  Calendar, Chat: POST /api/v1/meetings
```

Its pages follow the Meet screens in the [ui](https://github.com/openasy/ui) Storybook: today's meetings with where
each link came from and how many joined, the call with its shared screen, everyone's tile, the lobby and the chat,
the few recordings with who allowed them and when each is deleted, and the server with LiveKit's and TURN's health
and how each person connects. Pages are in English, Turkish and German, with numbers and dates in the viewer's
language.

## Meetings and links

Each meeting is a link, `https://meet.example.com/k7f-3qd-wx2`: made by hand ("Start a meeting now"), by Calendar
for an invitation, or by Chat for a channel. Everyone also has a room of their own whose link stays the same,
`https://meet.example.com/emily-clark`, for calls that are not in a calendar. The link is the key: anyone who has it
may ask to join.

- **People from the company** sign in, as they do in every OpenAsy product, and come straight in: Meet gives their
  browser a LiveKit access token for that room only, valid 15 minutes for joining (LiveKit renews it while they are
  connected), that lets them publish camera, microphone and screen, send chat and raise a hand, and nothing else.
- **Guests** give a name and, if they like, an email, and wait in the lobby. Anyone in the call, the organiser, or
  an admin lets them in or not. A guest gets a token only while someone from the company is in the call. A knock no
  one answers goes away after `lobby.wait`. The lobby shows whether a guest's email is on the invitation.
- **During the call**: video, audio, screen sharing (with its sound), raised hands, who speaks and whose connection
  is weak, and a chat that goes over LiveKit's data channel and is never stored. The call stays connected while the
  person opens other pages of Meet.
- **After the call**: when the last person leaves, LiveKit closes the room. Meet keeps who was in it (members by
  name, guests only counted: a guest's name is cleared when the call ends, and the lobby entry is deleted a day
  later), when it started and how long it ran, for the Meetings page. No IP address is ever stored.

## Recordings

A meeting is recorded only when all of these hold: its organiser allowed recording when the meeting was made, the
file lets the organiser record (their group is under `recording.allowed_for` and none of their groups is under
`never_for`), and the organiser presses Record while the call is live. Egress then records the room to an MP4 file.
LiveKit tells every browser in the room, which shows a red mark; people joining later, guests in the lobby among them,
are told before they come in. The recording lists the members who were in the call while it ran, and counts guests.

Each file is deleted on its day: `keep_days` of the group that allowed it, after the recording ended. Whoever started
it, or an admin, can delete it sooner. Members see the recordings they started or were in; viewers see all.

A person's groups are the groups in the file that list their email, and the groups their identity provider sent at
their last sign-in (`OPENASY_OIDC_SCOPES` with `groups`, and `OPENASY_OIDC_GROUPS_CLAIM`).

## The Server page

For IT: whether LiveKit answers, with its CPU, memory and running time when its Prometheus port is set
(`livekit.metrics_url`); each TURN listener in the file, checked every five minutes with a STUN request from Meet's
container; what flows through the server today, every 15 minutes, and how much of it through TURN; and each live
connection's media path (direct over UDP or TCP, or relayed through TURN over UDP, TCP or TLS), round trip, loss,
browser and what it sends. Browsers report these from WebRTC's own statistics every 15 seconds; Meet keeps each report
90 seconds, and only the sums per minute, for two days.

## What other products call

Calendar and Chat make meeting links with a Meet API token that has the editor role:

```http
POST /api/v1/meetings
Authorization: Bearer oa_meet_...
{ "source": "calendar", "reference": "<the event's UID>", "title": "Interview: support engineer",
  "organizer": { "email": "emily.clark@example.com" },
  "startsAt": "2026-11-05T10:30:00Z", "endsAt": "2026-11-05T11:30:00Z",
  "invited": ["candidate@example.net"] }
```

The answer's `url` goes into the invitation. Sent again with the same `reference`, the request answers the meeting
made the first time. `PATCH /api/v1/meetings/{id}` moves it, `DELETE` cancels it. The full API is described in
`openapi.json` and served at `/api/docs/`.

## The settings file

`/config/meet.yaml` (`MEET_CONFIG`); [config/meet.yaml](./config/meet.yaml) is a commented example. The file is the
only way in: no screen and no API route changes these. It is read at start and again within a minute of a change,
and applied whole or not at all; a file with a mistake leaves the last good version in place, and the log and the
Settings page say which field to fix. Without a file, Meet runs with LiveKit at `http://livekit:7880`, guests through
the lobby and no recordings.

| Field | Default | |
| --- | --- | --- |
| `time_zone` | `UTC` | The day the Meetings page lists |
| `organization` | | The company's name in the pages |
| `livekit.url` | `http://livekit:7880` | LiveKit's API, from Meet's container |
| `livekit.public_url` | `ws://localhost:7880` | Where browsers connect, `wss://`; the pages' CSP allows only it besides Meet |
| `livekit.api_key`, `api_secret` | `meet`, `MEET_LIVEKIT_SECRET` | The key, and the variable that holds its secret |
| `livekit.metrics_url` | | LiveKit's Prometheus endpoint, for the Server page |
| `livekit.media_ports` | | Shown on the Server page |
| `limits.meetings` | `20` | Meetings live at once |
| `limits.people` | `50` | People in one meeting (LiveKit's `maxParticipants`) |
| `limits.video` | `720p` | What cameras send at most |
| `limits.bandwidth` | | What the server's link carries, such as `400 Mbit/s` |
| `lobby.guests` | `true` | Whether people without an account may ask to join |
| `lobby.wait` | `15m` | How long a knock waits |
| `groups.<id>` | | `{ name, members: [emails] }` |
| `recording.allowed_for` | | `[{ group, keep_days }]`; without `recording`, no one records |
| `recording.never_for` | `[]` | Groups that never record |
| `recording.storage` | `/recordings` | The folder Egress writes to and Meet reads, the same in both |
| `turn` | `[]` | `[{ host, port, transport: udp, tcp or tls }]` to check |

## Run

`compose.yaml` runs Meet with LiveKit, Redis and Egress. LiveKit's own settings are in
[config/livekit.yaml](./config/livekit.yaml): its webhooks go to Meet, and its TURN serves networks that block
direct media.

```bash
openssl rand -hex 32 > openasy-kek
printf 'MEET_LIVEKIT_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
$EDITOR config/meet.yaml config/livekit.yaml
docker compose up -d
docker compose logs meet | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). Put TLS in
front of Meet (`https://meet.example.com`, port 8080), of LiveKit's signalling (`wss://rtc.example.com`, port 7880)
and of TURN (`turn.example.com:443`, port 5349); browsers open cameras and microphones only on https pages. Open UDP
50000 to 50100, TCP 7881 and UDP 3478 from outside. Everyone from the company signs in with the same address:
through your identity provider with `OPENASY_OIDC_DEFAULT_ROLE=user`, or invited as members with the user role.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `MEET_PUBLIC_URL` | `http://localhost:8080` | The address people open, and the start of every meeting's link |
| `MEET_CONFIG` | `/config/meet.yaml` | The settings file |
| `MEET_LIVEKIT_SECRET` | | LiveKit's API secret, or a file at `MEET_LIVEKIT_SECRET_FILE` (`/run/secrets/livekit-secret`) |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `MEET_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key (ADR 0021) |
| `MEET_DB` | `/data/meet.db` | SQLite file (WAL), on the `/data` volume |
| `MEET_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `MEET_HEADLESS` | `false` | `true` serves only the API |
| `MEET_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Its database
holds sign-in, the meetings, who was in each call and the list of recordings; the recordings themselves are in the
`recordings` volume.

## Roles

Members (the user role) start, join and record their own meetings, let guests in and see their own recordings.
Viewers are IT: they also see every meeting, every recording, the server, the integrations and the settings. Editors'
tokens let Calendar and Chat make meetings for someone. Admins also stop and delete any recording and manage members
and API tokens (ADR 0003). API tokens never join a call.

## Not yet

Webinars for hundreds of viewers, dial-in by phone, breakout rooms, live captions, end-to-end encryption (LiveKit
offers it; the pages do not turn it on yet), the guest's location on the Server page (Meet keeps no IP address), and
the links from Calendar and Chat, which those products still have to add.

## Develop

```bash
npm install
npm test        # tokens and grants, the lobby, who sees what, recordings, the file, webhooks, TURN checks, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
npm run openapi # after changing the API
```

Tests run against a LiveKit in memory (`server/fake-livekit.ts`) that answers the Twirp calls Meet makes, checks each
call's token and grant as LiveKit does, and sends signed webhooks.

`npm run e2e` (`e2e/run.sh`, also in CI) starts the livekit-server that `compose.yaml` pins, with Redis and Egress
when `E2E_EGRESS=1`, and runs Meet's server against it: tokens Meet mints checked by LiveKit itself, rooms within the
file's limits, people joined with LiveKit's command line tool seen through webhooks, a guest let in through the
lobby, a recording made, served and deleted, and the call ended with the guest's name forgotten.

## Licence

AGPL-3.0 (ADR 0008). LiveKit and Egress are Apache 2.0.
