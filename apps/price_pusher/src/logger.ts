import pino, { Logger, LoggerOptions } from "pino";
import { capturePinoLog, isSentryEnabled } from "./sentry";

export function createLogger(options: { level: string }): Logger {
  const hooks: LoggerOptions["hooks"] = isSentryEnabled()
    ? {
        logMethod(args, method, level) {
          capturePinoLog(args, level);
          return method.apply(this, args);
        },
      }
    : undefined;

  return pino({
    level: options.level,
    hooks,
  });
}
