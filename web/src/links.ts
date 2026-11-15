// Meeting links: https://meet.example.com/abc-def-ghi, or a person's own room, https://meet.example.com/emily-clark.
// The same rules as the server's (server/meet.ts): a link's last part, never a page's name.

/** Pages and paths that a meeting's link cannot take. */
export const RESERVED = new Set([
  "meetings",
  "meeting",
  "recordings",
  "server",
  "integrations",
  "settings",
  "account",
  "members",
  "signin",
  "tokens",
  "api",
  "assets",
  "join",
  "lobby",
  "healthz",
  "readyz",
  "metrics",
  "favicon",
]);
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A meeting's id from what people paste: a link with or without https://, or the code alone. */
export function codeOf(link: string): string | null {
  const s = link.trim().replace(/^[a-z]+:\/\//i, "");
  const last = s.split(/[?#]/)[0]!.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  return ID.test(last) && !RESERVED.has(last) ? last : null;
}

export const PAGES = ["meetings", "recordings", "server", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
export type Page = (typeof PAGES)[number];
export type Route = { page: Page } | { page: "meeting"; id: string };
/** The first path segments that are pages of this UI, for followLinks. Any other one is a meeting's link. */
export const PATHS = [...PAGES];

export function parseRoute(path: string): Route {
  const [page, extra] = path.replace(/^\//, "").split("/");
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  const id = codeOf(decodeURIComponent(page ?? ""));
  if (id && !extra) return { page: "meeting", id };
  return { page: "meetings" };
}
