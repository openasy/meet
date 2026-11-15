// What the pages share: data loading with the session, a notice line, and numbers, times and lengths in the viewer's language.
import { useAuth } from "@openasy/auth/react";
import { IconButton } from "@openasy/ui";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";
import { viewerLocale, type T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

/** Loads a path when it changes, and again every `everyMs`; `reload` loads it now. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null, everyMs?: number) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () =>
      void call<R>(path).then(
        (d) => live && setData(d),
        () => live && setData((old) => (old === undefined ? null : old)),
      );
    load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [call, path, n, everyMs]);
  return [data, () => setN((x) => x + 1)] as const;
}

export const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success", className = "" }: { children: ReactNode; tone?: "success" | "danger"; className?: string }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"} ${className}`}
    >
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="meet-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

/** A link in a box, with a button that copies it. */
export function LinkBox({ link, label, onCopied, small }: { link: string; label: string; onCopied: () => void; small?: boolean }) {
  return (
    <span className="flex items-center gap-1 rounded-md bg-canvas px-2 py-1.5">
      <code className={`min-w-0 grow truncate font-mono ${small ? "text-xs" : "text-sm"} text-fg`}>{shortLink(link)}</code>
      <IconButton label={label} size="xs" onClick={() => void copy(link).then(onCopied)}>
        <Copy className="size-3.5" />
      </IconButton>
    </span>
  );
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Without clipboard rights the link stays on screen to copy by hand.
  }
}

/** A meeting's link as people say it: meet.example.com/abc-def-ghi. */
export const shortLink = (url: string) => url.replace(/^https?:\/\//, "");

// ---------------------------------------------------------------- formatting

export const num = (n: number, digits = 0, locale: string = viewerLocale()) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);

/** A percentage as the language writes it: 3.8% in English, %3,8 in Turkish, 3,8 % in German. */
export const pct = (n: number, digits = 1, locale: string = viewerLocale()) =>
  new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n / 100);

export const clock = (iso: string, locale: string = viewerLocale()) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

export const dayLong = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });

export const dayShort = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });

export const dayMonth = (iso: string, locale: string = viewerLocale()) => new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short" });

export const when = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleString(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** 1 h 29 min, or 37 min. */
export function length(minutes: number, t: T) {
  const h = Math.floor(minutes / 60);
  return h ? t("common.hoursMinutes", { h, m: minutes % 60 }) : t("common.minutes", { count: minutes });
}

/** 06:12, or 1:06:12, for a call's running time. */
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

export const gb = (bytes: number, locale: string = viewerLocale()) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 ** 3);

/** The time now, ticking every second, for a call's clock. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
