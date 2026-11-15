import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { CalendarDays, CircleDot, KeyRound, LogIn, LogOut, Plug, Server as ServerIcon, Settings as SettingsIcon, UserRound, Users, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Me, MeetingList, ProductLink, Settings } from "./api.ts";
import { CallView, type ActiveCall } from "./Call.tsx";
import { useApi, useLoad, type Call } from "./common.tsx";
import { GuestApp } from "./Guest.tsx";
import { parseRoute, type Page } from "./links.ts";
import { useT, setViewerLocale } from "./i18n.ts";
import { MeetingRoute } from "./MeetingRoute.tsx";
import { MeetingsPage } from "./Meetings.tsx";
import { IntegrationsPage, SettingsFilePage } from "./pages.tsx";
import { RecordingsPage } from "./Recordings.tsx";
import { ServerPage } from "./Server.tsx";

/** Pages for viewers and above: IT. */
const IT: readonly Page[] = ["server", "integrations", "settings"];
/** Where to come back to after signing in through an identity provider, from a meeting's link. */
const RETURN_KEY = "meet-return";

export interface Ctx {
  call: Call;
  me: Me;
  /** Joins a meeting in this tab, ending a call in another one first. */
  startCall: (c: ActiveCall) => void;
  active: ActiveCall | null;
  onChanged: () => void;
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me: auth, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const call = useApi();
  const it = can("viewer");
  const [me, reloadMe] = useLoad<Me>(call, "/api/v1/me");
  const [settings] = useLoad<Settings>(call, it ? "/api/v1/settings" : null, 60_000);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const [active, setActive] = useState<ActiveCall | null>(null);

  useEffect(() => {
    // Back from an identity provider, to the meeting whose link was opened.
    try {
      const back = sessionStorage.getItem(RETURN_KEY);
      if (back) {
        sessionStorage.removeItem(RETURN_KEY);
        if (back !== window.location.pathname) navigate(back, { replace: true });
      }
    } catch {
      // Storage may be off; the person opens the link again.
    }
  }, []);

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "meet" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  // The search window (Cmd+K) finds today's meetings by title or organiser.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<MeetingList>("/api/v1/meetings", { signal });
      const needle = q.toLowerCase();
      return r.meetings
        .filter((m) => `${m.title} ${m.organizer.name} ${m.id}`.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((m) => ({ id: m.id, label: m.title, detail: m.organizer.name, kind: msg("search.meeting"), icon: Video, href: `/${m.id}` }));
    },
    [call, msg],
  );

  const startCall = useCallback((c: ActiveCall) => setActive(c), []);
  const inCall = !!active && !active.left;
  const nav = [
    { id: "meetings", label: msg("nav.meetings"), icon: CalendarDays },
    ...(inCall ? [{ id: "meeting", label: msg("nav.call"), icon: Video, count: msg("nav.live") }] : []),
    { id: "recordings", label: msg("nav.recordings"), icon: CircleDot },
    ...(it ? [{ id: "server", label: msg("nav.server"), icon: ServerIcon }] : []),
  ];
  const footerNav = [
    ...(it
      ? [
          { id: "integrations", label: msg("nav.integrations"), icon: Plug },
          { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
        ]
      : []),
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const onCallPage = route.page === "meeting" && active?.id === route.id;
  const activeNav = route.page === "meeting" ? (onCallPage && inCall ? "meeting" : "meetings") : route.page;
  const roleName = msg(`roles.${(["owner", "admin", "editor", "viewer", "user"].includes(auth.user.role) ? auth.user.role : "user") as "user"}`);
  const ctx: Ctx | null = me ? { call, me, startCall, active, onChanged: reloadMe } : null;

  return (
    <AppShell
      product="meet"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={activeNav}
      onNavigate={(id) => navigate(id === "meeting" && active ? `/${active.id}` : `/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: auth.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {settings.file.error}
        </Callout>
      )}
      {/* The call stays connected while other pages are open; it is shown on its own link only. */}
      {ctx && active && (
        <div hidden={!onCallPage} className={onCallPage ? "contents" : undefined}>
          <CallView key={`${active.id}:${active.access.token.slice(-12)}`} {...ctx} active={active} onLeft={() => setActive({ ...active, left: true })} />
        </div>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : IT.includes(route.page as Page) && !it ? (
        <EmptyState title={msg("auth.itOnly")}>{msg("auth.itOnlyDetail")}</EmptyState>
      ) : me === null ? (
        <EmptyState title={msg("loadFailed")} />
      ) : !ctx ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "meeting" ? (
        onCallPage ? null : (
          <MeetingRoute key={route.id} {...ctx} id={route.id} />
        )
      ) : route.page === "recordings" ? (
        <RecordingsPage {...ctx} />
      ) : route.page === "server" ? (
        <ServerPage {...ctx} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage {...ctx} />
      ) : route.page === "settings" ? (
        settings ? (
          <SettingsFilePage settings={settings} />
        ) : (
          <PageHeader title={msg("loading")} />
        )
      ) : (
        <MeetingsPage {...ctx} />
      )}
    </AppShell>
  );
}

/** A meeting's link opened without a session: the guest's way in, unless they choose to sign in. */
function Entry() {
  const route = parseRoute(usePath());
  const [state, setState] = useState<"checking" | "guest" | "member">(route.page === "meeting" ? "checking" : "member");
  const [locale] = useLocalePreference();
  const t = useT();
  useEffect(() => {
    if (state !== "checking") return;
    void fetch("/api/v1/auth/me", { credentials: "same-origin" }).then(
      (r) => setState(r.ok ? "member" : "guest"),
      () => setState("guest"),
    );
  }, [state]);
  if (state === "checking") return <p className="p-4 text-sm text-fg-muted">{t("loading")}</p>;
  if (state === "guest" && route.page === "meeting")
    return (
      <GuestApp
        id={route.id}
        locale={locale}
        onSignIn={() => {
          try {
            sessionStorage.setItem(RETURN_KEY, `/${route.id}`);
          } catch {
            // Without storage the person comes back to the meetings list.
          }
          setState("member");
        }}
      />
    );
  return (
    <AuthGate product="OpenAsy Meet">
      <Product />
    </AuthGate>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <Entry />
    </BrandProvider>
  );
}
