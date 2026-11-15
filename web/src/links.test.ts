import { describe, expect, it } from "vitest";
import { codeOf, parseRoute } from "./links.ts";

describe("meeting links", () => {
  it("reads a meeting's id from what people paste", () => {
    expect(codeOf("https://meet.example.com/k7f-3qd-wx2")).toBe("k7f-3qd-wx2");
    expect(codeOf("meet.example.com/emily-clark?x=1")).toBe("emily-clark");
    expect(codeOf("K7F-3QD-WX2")).toBe("k7f-3qd-wx2");
    expect(codeOf("https://meet.example.com/recordings")).toBeNull();
    expect(codeOf("not a link")).toBeNull();
  });

  it("tells pages from meetings", () => {
    expect(parseRoute("/recordings")).toEqual({ page: "recordings" });
    expect(parseRoute("/k7f-3qd-wx2")).toEqual({ page: "meeting", id: "k7f-3qd-wx2" });
    expect(parseRoute("/")).toEqual({ page: "meetings" });
    expect(parseRoute("/a/b")).toEqual({ page: "meetings" });
  });
});
