// Checks that each TURN listener in the file answers: a STUN Binding request (RFC 8489), over UDP, TCP or TLS, which
// every TURN server answers without credentials. It runs from Meet's own container, so it shows that the listener is up
// and reachable from there, not that every network outside gets through.
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Transport } from "./config.ts";

const MAGIC = 0x2112a442;

export function bindingRequest(): { packet: Buffer; id: Buffer } {
  const id = randomBytes(12);
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt32BE(MAGIC, 4);
  id.copy(packet, 8);
  return { packet, id };
}

/** True when the bytes are a STUN Binding success (or error) response to the request with this id. */
export function isBindingResponse(b: Buffer, id: Buffer): boolean {
  if (b.length < 20) return false;
  const type = b.readUInt16BE(0);
  return (type === 0x0101 || type === 0x0111) && b.readUInt32BE(4) === MAGIC && b.subarray(8, 20).equals(id);
}

export interface TurnCheck {
  host: string;
  port: number;
  transport: Transport;
  ok: boolean;
  ms: number | null;
  error: string | null;
  at: string;
}

export async function checkTurn(host: string, port: number, transport: Transport, timeoutMs = 4000): Promise<TurnCheck> {
  const started = performance.now();
  const at = new Date().toISOString();
  const { packet, id } = bindingRequest();
  const done = (ok: boolean, error: string | null): TurnCheck => ({
    host,
    port,
    transport,
    ok,
    ms: ok ? Math.round(performance.now() - started) : null,
    error,
    at,
  });
  return new Promise<TurnCheck>((resolve) => {
    let finished = false;
    let cleanup = () => {};
    const finish = (ok: boolean, error: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve(done(ok, error));
    };
    const timer = setTimeout(() => finish(false, `No answer within ${timeoutMs / 1000} s.`), timeoutMs);
    if (transport === "udp") {
      const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
      cleanup = () => sock.close();
      sock.on("message", (m) => isBindingResponse(m, id) && finish(true, null));
      sock.on("error", (e) => finish(false, e.message));
      sock.send(packet, port, host, (e) => e && finish(false, e.message));
      return;
    }
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 20) finish(isBindingResponse(buf, id), isBindingResponse(buf, id) ? null : "It answered, but not as a TURN server.");
    };
    const sock: Socket =
      transport === "tls"
        ? tlsConnect({ host, port, servername: /^[\d.:]+$/.test(host) ? undefined : host }, () => sock.write(packet))
        : tcpConnect({ host, port }, () => sock.write(packet));
    cleanup = () => sock.destroy();
    sock.on("data", onData);
    sock.on("error", (e) => finish(false, e.message));
  });
}
