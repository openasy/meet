import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createMeet } from "./meet.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const env = process.env;
const port = Number(env.PORT ?? 8080);
const dbPath = env.MEET_DB ?? "/data/meet.db";
const configPath = env.MEET_CONFIG?.trim() || "/config/meet.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
// true to serve the API without the web UI (ADR 0018).
const headless = env.MEET_HEADLESS === "true";
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = env.MEET_METRICS_PORT ? Number(env.MEET_METRICS_PORT) : undefined;

// LiveKit's API secret: in the variable the file names (MEET_LIVEKIT_SECRET by default), or in a mounted secret.
const secretFile = env.MEET_LIVEKIT_SECRET_FILE ?? "/run/secrets/livekit-secret";
const secrets: Record<string, string | undefined> = { ...env };
if (!secrets.MEET_LIVEKIT_SECRET && existsSync(secretFile)) secrets.MEET_LIVEKIT_SECRET = readFileSync(secretFile, "utf8").trim();

const db = openDb(dbPath);
// The address people open Meet at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and meeting links use it.
const publicUrl = (env.MEET_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = env.MEET_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
let file: ReturnType<typeof watchConfig> | undefined;
const auth = createAuth({
  db,
  product: "meet",
  productName: "OpenAsy Meet",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: env.MEET_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(env),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Everyone from the company signs in as a user to skip the lobby; viewers and admins are IT.
  users: true,
  // The groups the identity provider sends decide who may record, with the groups in meet.yaml.
  onOidcSignIn: ({ userId, groups }) => meet.noteGroups(userId, groups),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
// After sign-in's tables exist: Meet reads members' names and emails from them.
const meet = createMeet(db, { publicUrl, env: secrets, fileState: () => file?.state ?? null });
// The settings come from the file and only from it; a file with a mistake keeps the last good one in place. Without a
// file, Meet runs with LiveKit at http://livekit:7880, guests through the lobby and no recordings.
file = watchConfig(configPath, (config, text) => meet.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
if (!file.state.appliedAt) meet.setConfig(meet.config(), "");

const products = parseProducts(env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    meet,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(meet, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "meet started", { version, port, db: dbPath, config: configPath, livekit: meet.config().livekit.url, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl))
  log("warn", "MEET_PUBLIC_URL is not https: browsers allow cameras and microphones only on https pages. Put Meet behind TLS (ADR 0026)", { url: publicUrl });
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const safely = (name: string, work: () => unknown) => async () => {
  try {
    await work();
  } catch (err) {
    log("warn", `${name} failed`, { error: (err as Error).message });
  }
};
const reconcile = safely("checking LiveKit", () => meet.reconcile());
const turn = safely("checking TURN", () => meet.checkTurnNow());
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  // Webhooks tell of changes at once; this catches what they missed, and works without them.
  setInterval(reconcile, 15_000),
  setInterval(
    safely("sampling media", () => meet.sampleMedia()),
    60_000,
  ),
  setInterval(
    safely("reading LiveKit's metrics", () => meet.sampleMetrics()),
    60_000,
  ),
  setInterval(turn, 5 * 60_000),
  setInterval(
    safely("deleting recordings past their days", () => meet.retention()),
    60 * 60_000,
  ),
];
void reconcile();
void turn();
void safely("reading LiveKit's metrics", () => meet.sampleMetrics())();
void safely("deleting recordings past their days", () => meet.retention())();

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
