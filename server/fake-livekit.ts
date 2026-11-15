// A LiveKit server in memory, for tests: the RoomService and Egress calls Meet makes over Twirp, answered in the shape
// livekit-server answers them (protobuf JSON with snake_case names and 64-bit numbers as strings), checking each call's
// token and grant as LiveKit does. Tests add and remove participants by hand and send the webhooks LiveKit would.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signWebhook, verifyJwt, type VideoGrant } from "./livekit.ts";

export const API_KEY = "meet-test";
export const API_SECRET = "meet-test-secret-0123456789abcdef0123456789";

interface Room {
  sid: string;
  name: string;
  created: number;
  maxParticipants: number;
  emptyTimeout: number;
  metadata: string;
  participants: Map<string, { sid: string; identity: string; name: string; metadata: string; joinedAt: number }>;
}

interface Egress {
  egressId: string;
  roomName: string;
  status: string;
  startedAt: number;
  endedAt: number;
  filepath: string;
  error: string;
}

export async function startFakeLiveKit() {
  const state = {
    rooms: new Map<string, Room>(),
    egress: new Map<string, Egress>(),
    /** Every call: method and the grant it came with. */
    calls: [] as Array<{ method: string; grant: VideoGrant; body: Record<string, unknown> }>,
    /** When set, every call answers this status. */
    down: 0,
    /** When set, StartRoomCompositeEgress fails with it. */
    egressError: "",
    seq: 0,
  };
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const roomJson = (r: Room) => ({
    sid: r.sid,
    name: r.name,
    empty_timeout: r.emptyTimeout,
    max_participants: r.maxParticipants,
    creation_time: String(Math.floor(r.created / 1000)),
    metadata: r.metadata,
    num_participants: r.participants.size,
    active_recording: [...state.egress.values()].some((e) => e.roomName === r.name && e.status === "EGRESS_ACTIVE"),
  });
  const participantJson = (p: { sid: string; identity: string; name: string; metadata: string; joinedAt: number }) => ({
    sid: p.sid,
    identity: p.identity,
    name: p.name,
    metadata: p.metadata,
    state: "ACTIVE",
    joined_at: String(Math.floor(p.joinedAt / 1000)),
  });
  const egressJson = (e: Egress) => ({
    egress_id: e.egressId,
    room_name: e.roomName,
    status: e.status,
    started_at: ns(e.startedAt),
    ...(e.endedAt && { ended_at: ns(e.endedAt) }),
    ...(e.error && { error: e.error }),
    file_results:
      e.status === "EGRESS_COMPLETE" ? [{ filename: e.filepath, size: "1048576", duration: ns(e.endedAt - e.startedAt), location: e.filepath }] : [],
  });

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/") return res.writeHead(200).end("OK");
      const m = /^\/twirp\/livekit\.(RoomService|Egress)\/(\w+)$/.exec(req.url ?? "");
      if (!m || req.method !== "POST") return reply(404, { code: "bad_route", msg: "no such method" });
      if (state.down) return reply(state.down, { code: "unavailable", msg: "down for the test" });
      const claims = verifyJwt((req.headers.authorization ?? "").replace(/^Bearer /, ""), API_SECRET);
      if (!claims || claims.iss !== API_KEY) return reply(401, { code: "unauthenticated", msg: "invalid token" });
      const grant = (claims.video ?? {}) as VideoGrant;
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const method = m[2]!;
      state.calls.push({ method, grant, body });
      const need = (ok: boolean) => {
        if (!ok) reply(403, { code: "permission_denied", msg: `the token's grant does not allow ${method}` });
        return ok;
      };
      const roomName = String(body.room ?? body.name ?? body.roomName ?? body.room_name ?? "");
      switch (method) {
        case "ListRooms": {
          if (!need(!!grant.roomList)) return;
          const names = body.names as string[] | undefined;
          return reply(200, { rooms: [...state.rooms.values()].filter((r) => !names?.length || names.includes(r.name)).map(roomJson) });
        }
        case "CreateRoom": {
          if (!need(!!grant.roomCreate)) return;
          let r = state.rooms.get(roomName);
          if (!r) {
            r = {
              sid: `RM_${++state.seq}`,
              name: roomName,
              created: Date.now(),
              maxParticipants: Number(body.maxParticipants ?? body.max_participants ?? 0),
              emptyTimeout: Number(body.emptyTimeout ?? body.empty_timeout ?? 0),
              metadata: String(body.metadata ?? ""),
              participants: new Map(),
            };
            state.rooms.set(roomName, r);
          }
          return reply(200, roomJson(r));
        }
        case "DeleteRoom":
          if (!need(!!grant.roomCreate)) return;
          state.rooms.delete(roomName);
          return reply(200, {});
        case "ListParticipants": {
          if (!need(!!grant.roomAdmin && grant.room === roomName)) return;
          const r = state.rooms.get(roomName);
          if (!r) return reply(404, { code: "not_found", msg: "requested room does not exist" });
          return reply(200, { participants: [...r.participants.values()].map(participantJson) });
        }
        case "RemoveParticipant": {
          if (!need(!!grant.roomAdmin && grant.room === roomName)) return;
          state.rooms.get(roomName)?.participants.delete(String(body.identity));
          return reply(200, {});
        }
        case "StartRoomCompositeEgress": {
          if (!need(!!grant.roomRecord)) return;
          if (state.egressError) return reply(500, { code: "internal", msg: state.egressError });
          if (!state.rooms.has(roomName)) return reply(404, { code: "not_found", msg: "room not found" });
          const outputs = (body.fileOutputs ?? body.file_outputs) as Array<{ filepath: string }>;
          const e: Egress = {
            egressId: `EG_${++state.seq}`,
            roomName,
            status: "EGRESS_ACTIVE",
            startedAt: Date.now(),
            endedAt: 0,
            filepath: outputs[0]!.filepath,
            error: "",
          };
          state.egress.set(e.egressId, e);
          return reply(200, egressJson(e));
        }
        case "StopEgress": {
          if (!need(!!grant.roomRecord)) return;
          const e = state.egress.get(String(body.egressId ?? body.egress_id));
          if (!e) return reply(404, { code: "not_found", msg: "egress not found" });
          e.status = "EGRESS_ENDING";
          return reply(200, egressJson(e));
        }
        case "ListEgress": {
          if (!need(!!grant.roomRecord)) return;
          return reply(200, { items: [...state.egress.values()].filter((e) => !roomName || e.roomName === roomName).map(egressJson) });
        }
        default:
          return reply(404, { code: "bad_route", msg: `${method} is not faked` });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;

  return {
    url,
    state,
    /** Someone connects with a token, as a browser would after Meet gave them one. */
    join(room: string, identity: string, name: string, metadata = "") {
      const r = state.rooms.get(room);
      if (!r) throw new Error(`no room ${room}`);
      const p = { sid: `PA_${++state.seq}`, identity, name, metadata, joinedAt: Date.now() };
      r.participants.set(identity, p);
      return { room: roomJson(r), participant: participantJson(p) };
    },
    leave(room: string, identity: string) {
      const r = state.rooms.get(room)!;
      const p = r.participants.get(identity)!;
      r.participants.delete(identity);
      return { room: roomJson(r), participant: participantJson(p) };
    },
    /** The last person left and the empty timeout passed. */
    close(room: string) {
      const r = state.rooms.get(room)!;
      state.rooms.delete(room);
      for (const e of state.egress.values())
        if (e.roomName === room && e.status !== "EGRESS_COMPLETE") Object.assign(e, { status: "EGRESS_COMPLETE", endedAt: Date.now() });
      return { room: roomJson(r) };
    },
    /** Egress finished writing the file. */
    finishEgress(egressId: string, status = "EGRESS_COMPLETE", error = "") {
      const e = state.egress.get(egressId)!;
      Object.assign(e, { status, endedAt: Date.now() + 60_000, error });
      return egressJson(e);
    },
    /** A webhook as LiveKit sends it: the event's JSON, signed. */
    webhook(event: string, payload: Record<string, unknown>, secret = API_SECRET) {
      const body = JSON.stringify({ event, id: `EV_${++state.seq}`, created_at: String(Math.floor(Date.now() / 1000)), ...payload });
      return { body, authorization: signWebhook(body, API_KEY, secret) };
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type FakeLiveKit = Awaited<ReturnType<typeof startFakeLiveKit>>;
