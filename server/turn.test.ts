import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { bindingRequest, checkTurn, isBindingResponse } from "./turn.ts";

/** What a TURN server answers to a Binding request: a success response with the same transaction id. */
const answer = (req: Buffer) => {
  const res = Buffer.from(req);
  res.writeUInt16BE(0x0101, 0);
  return res;
};

describe("TURN checks", () => {
  it("knows a Binding response to its own request only", () => {
    const { packet, id } = bindingRequest();
    expect(packet.length).toBe(20);
    expect(isBindingResponse(answer(packet), id)).toBe(true);
    expect(isBindingResponse(answer(bindingRequest().packet), id)).toBe(false);
    expect(isBindingResponse(packet, id)).toBe(false);
  });

  it("asks over UDP", async () => {
    const sock = createSocket("udp4");
    sock.on("message", (m, r) => sock.send(answer(m), r.port, r.address));
    await new Promise<void>((resolve) => sock.bind(0, "127.0.0.1", resolve));
    const c = await checkTurn("127.0.0.1", sock.address().port, "udp");
    sock.close();
    expect(c).toMatchObject({ ok: true, error: null, transport: "udp" });
  });

  it("asks over TCP, and says when something else answers", async () => {
    const good = createServer((s) => s.on("data", (d: Buffer) => s.write(answer(d))));
    const bad = createServer((s) => s.on("data", () => s.write("HTTP/1.1 400 Bad Request\r\n\r\n")));
    await new Promise<void>((r) => good.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    expect(await checkTurn("127.0.0.1", (good.address() as AddressInfo).port, "tcp")).toMatchObject({ ok: true });
    expect(await checkTurn("127.0.0.1", (bad.address() as AddressInfo).port, "tcp")).toMatchObject({
      ok: false,
      error: "It answered, but not as a TURN server.",
    });
    good.close();
    bad.close();
  });

  it("says when nothing answers", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    expect((await checkTurn("127.0.0.1", port, "tcp", 1000)).ok).toBe(false);
    const silent = createSocket("udp4");
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
    expect(await checkTurn("127.0.0.1", silent.address().port, "udp", 300)).toMatchObject({ ok: false, error: "No answer within 0.3 s." });
    silent.close();
  });
});
