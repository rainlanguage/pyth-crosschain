import * as Sentry from "@sentry/node";

type SentryLevel = "fatal" | "error" | "warning" | "info" | "debug";

let sentryInitialized = false;

const PINO_LEVEL_WARN = 40;
const PINO_LEVEL_ERROR = 50;
const PINO_LEVEL_FATAL = 60;

function minLevelFromEnv(): number {
  switch (process.env.SENTRY_MIN_LOG_LEVEL?.toLowerCase()) {
    case "error":
      return PINO_LEVEL_ERROR;
    case "fatal":
      return PINO_LEVEL_FATAL;
    case "info":
      return 30;
    default:
      return PINO_LEVEL_WARN;
  }
}

export function isSentryEnabled(): boolean {
  return sentryInitialized;
}

export type SentryInitOptions = {
  dsn?: string;
  environment?: string;
  release?: string;
};

/** Initialize Sentry when a DSN is set (env `SENTRY_DSN` or explicit option). */
export function initSentry(options: SentryInitOptions = {}): boolean {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    return false;
  }

  if (sentryInitialized) {
    return true;
  }

  Sentry.init({
    dsn,
    environment:
      options.environment ??
      process.env.SENTRY_ENVIRONMENT ??
      process.env.NODE_ENV ??
      "production",
    release:
      options.release ??
      process.env.SENTRY_RELEASE ??
      process.env.GIT_COMMIT,
    tracesSampleRate: 0,
  });

  sentryInitialized = true;
  return true;
}

export function setupSentryShutdownFlush(): void {
  if (!sentryInitialized) {
    return;
  }

  const flush = () => {
    void Sentry.close(2000).finally(() => process.exit(0));
  };

  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
}

function pinoLevelToSentryLevel(level: number): SentryLevel {
  if (level >= PINO_LEVEL_FATAL) {
    return "fatal";
  }
  if (level >= PINO_LEVEL_ERROR) {
    return "error";
  }
  return "warning";
}

/** Forward pino warn/error/fatal logs to Sentry as events. */
export function capturePinoLog(args: unknown[], level: number): void {
  if (!sentryInitialized || level < minLevelFromEnv()) {
    return;
  }

  const sentryLevel = pinoLevelToSentryLevel(level);
  let context: Record<string, unknown> = {};
  let message: string | undefined;
  let error: Error | undefined;

  if (typeof args[0] === "string") {
    message = args[0];
  } else if (typeof args[0] === "object" && args[0] !== null) {
    const record = args[0] as Record<string, unknown>;
    context = { ...record };
    if (record.err instanceof Error) {
      error = record.err;
      delete context.err;
    }
    message = typeof args[1] === "string" ? args[1] : undefined;
  }

  if (error) {
    Sentry.captureException(error, {
      level: sentryLevel,
      extra: { ...context, ...(message ? { message } : {}) },
    });
    return;
  }

  if (!message) {
    message =
      Object.keys(context).length > 0
        ? JSON.stringify(context)
        : "Price pusher log event";
  }

  // Transient RPC poll failures are logged locally; skip Sentry unless verbose.
  if (
    process.env.SENTRY_CAPTURE_POLL_ERRORS !== "true" &&
    message.includes("Polling on-chain price")
  ) {
    return;
  }

  Sentry.captureMessage(message, {
    level: sentryLevel,
    extra: context,
  });
}

function captureSuccessUpdatesEnabled(): boolean {
  return process.env.SENTRY_CAPTURE_SUCCESS_UPDATES !== "false";
}

/** Report a confirmed on-chain price update (info-level; not gated by SENTRY_MIN_LOG_LEVEL). */
export function capturePriceUpdateSuccess(
  context: Record<string, unknown>,
): void {
  if (!sentryInitialized || !captureSuccessUpdatesEnabled()) {
    return;
  }

  Sentry.captureMessage("Price update confirmed on-chain", {
    level: "info",
    extra: context,
  });
}
