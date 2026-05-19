import { capturePriceUpdateSuccess, isSentryEnabled } from "./sentry";
import * as Sentry from "@sentry/node";
import { UpdateCondition } from "./price-config";

function monitoringEnabled(): boolean {
  return (
    isSentryEnabled() && process.env.SENTRY_PUSH_CYCLE_MONITORING !== "false"
  );
}

let cycleNumber = 0;
let lastCycleStartedAtMs: number | undefined;
let lastOnChainSuccessAtMs: number | undefined;
let lastOnChainSuccessTxHash: string | undefined;
let previousCycleMaxStaleSec = 0;
let previousCyclePushAttempted = false;

/** Max ms since last on-chain success before a Sentry warning (default: 125% of pushing-frequency). */
export function getMaxMsSinceOnChainSuccess(
  pushingFrequencySec: number,
): number {
  const fromEnv = process.env.SENTRY_MAX_MS_SINCE_ON_CHAIN_SUCCESS;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return pushingFrequencySec * 1000 * 1.25;
}

/** Only warn about push gaps when feeds were actually stale (avoids weekend/market-close noise). */
function shouldWarnPushIntervalExceeded(
  msSinceLastSuccess: number,
  pushingFrequencySec: number,
): boolean {
  if (process.env.SENTRY_INTERVAL_WARN_ALWAYS === "true") {
    return msSinceLastSuccess > getMaxMsSinceOnChainSuccess(pushingFrequencySec);
  }

  const minStaleSec = Number(
    process.env.SENTRY_INTERVAL_WARN_MIN_STALE_SEC ?? "240",
  );
  const marketLikelyActive =
    previousCyclePushAttempted || previousCycleMaxStaleSec >= minStaleSec;

  if (!marketLikelyActive) {
    return false;
  }

  return msSinceLastSuccess > getMaxMsSinceOnChainSuccess(pushingFrequencySec);
}

export function recordPushCycleContext(
  pushAttempted: boolean,
  maxStaleSec: number,
): void {
  previousCyclePushAttempted = pushAttempted;
  previousCycleMaxStaleSec = maxStaleSec;
}

export type FeedStalenessSummary = {
  alias: string;
  timeLagSec: number;
  condition: UpdateCondition;
};

export type PushCycleFeedStats = {
  yesCount: number;
  earlyCount: number;
  noCount: number;
  missingSourceCount: number;
  feedsToPush: number;
  maxStaleSec: number;
  stalestFeeds: FeedStalenessSummary[];
};

export function markPushCycleStarted(pushingFrequencySec: number): number {
  cycleNumber += 1;
  lastCycleStartedAtMs = Date.now();

  if (!monitoringEnabled()) {
    return lastCycleStartedAtMs;
  }

  const msSinceLastSuccess =
    lastOnChainSuccessAtMs === undefined
      ? undefined
      : lastCycleStartedAtMs - lastOnChainSuccessAtMs;

  const maxMsSinceOnChainSuccess =
    getMaxMsSinceOnChainSuccess(pushingFrequencySec);

  Sentry.captureMessage("Push cycle started", {
    level: "info",
    extra: {
      cycleNumber,
      pushingFrequencySec,
      msSinceLastOnChainSuccess: msSinceLastSuccess,
      maxMsSinceOnChainSuccess,
      targetIntervalMs: pushingFrequencySec * 1000,
      lastOnChainSuccessTxHash,
      previousCycleMaxStaleSec,
      previousCyclePushAttempted,
    },
  });

  if (
    msSinceLastSuccess !== undefined &&
    shouldWarnPushIntervalExceeded(msSinceLastSuccess, pushingFrequencySec)
  ) {
    Sentry.captureMessage("Push interval exceeded target (possible delay)", {
      level: "warning",
      extra: {
        cycleNumber,
        msSinceLastOnChainSuccess: msSinceLastSuccess,
        maxMsSinceOnChainSuccess,
        targetIntervalMs: pushingFrequencySec * 1000,
        excessMs: msSinceLastSuccess - maxMsSinceOnChainSuccess,
        lastOnChainSuccessTxHash,
        previousCycleMaxStaleSec,
        previousCyclePushAttempted,
      },
    });
  }

  return lastCycleStartedAtMs;
}

export function capturePushCycleNoPush(
  pushingFrequencySec: number,
  stats: PushCycleFeedStats,
): void {
  if (!monitoringEnabled()) {
    return;
  }

  const reason =
    stats.earlyCount > 0
      ? "only_early_feeds_need_update"
      : "no_feeds_need_update";

  Sentry.captureMessage("Push cycle skipped — no on-chain update", {
    level: "info",
    extra: {
      cycleNumber,
      reason,
      pushingFrequencySec,
      ...stats,
      note:
        stats.earlyCount > 0 && stats.yesCount === 0
          ? "EARLY feeds need update but batch requires at least one YES feed"
          : undefined,
    },
  });
}

export function capturePushCycleTriggered(
  pushingFrequencySec: number,
  stats: PushCycleFeedStats,
  pushStartedAtMs: number,
): void {
  if (!monitoringEnabled()) {
    return;
  }

  Sentry.captureMessage("Push cycle triggered on-chain update", {
    level: "info",
    extra: {
      cycleNumber,
      pushingFrequencySec,
      msSinceCycleStart: Date.now() - pushStartedAtMs,
      ...stats,
    },
  });
}

export function capturePushCycleOverrun(
  pushingFrequencySec: number,
  cycleElapsedMs: number,
): void {
  if (!monitoringEnabled()) {
    return;
  }

  Sentry.captureMessage("Push cycle longer than pushing-frequency", {
    level: "warning",
    extra: {
      cycleNumber,
      pushingFrequencySec,
      cycleElapsedMs,
      targetIntervalMs: pushingFrequencySec * 1000,
      overrunMs: cycleElapsedMs - pushingFrequencySec * 1000,
    },
  });
}

export function capturePushCycleFinished(
  pushingFrequencySec: number,
  context: {
    feedsToPush: number;
    chunksAttempted?: number;
    chunksConfirmed?: number;
    pushDurationMs: number;
    error?: unknown;
  },
): void {
  if (!monitoringEnabled()) {
    return;
  }

  Sentry.captureMessage(
    context.error ? "Push cycle finished with error" : "Push cycle finished",
    {
      level: context.error ? "error" : "info",
      extra: {
        cycleNumber,
        pushingFrequencySec,
        pushDurationMs: context.pushDurationMs,
        feedsToPush: context.feedsToPush,
        chunksAttempted: context.chunksAttempted,
        chunksConfirmed: context.chunksConfirmed,
        msSinceLastOnChainSuccess:
          lastOnChainSuccessAtMs === undefined
            ? undefined
            : Date.now() - lastOnChainSuccessAtMs,
        error:
          context.error instanceof Error
            ? context.error.message
            : context.error,
      },
    },
  );
}

export function capturePushChunkSkipped(
  reason: string,
  context: Record<string, unknown>,
): void {
  if (!monitoringEnabled()) {
    return;
  }

  Sentry.captureMessage("Price update chunk skipped", {
    level: "warning",
    extra: {
      cycleNumber,
      reason,
      ...context,
    },
  });
}

export function recordOnChainPushSuccess(txHash: string): void {
  lastOnChainSuccessAtMs = Date.now();
  lastOnChainSuccessTxHash = txHash;
}

export function reportOnChainPushSuccess(
  context: Record<string, unknown>,
): void {
  const hash = context.hash;
  const now = Date.now();
  const msSincePreviousOnChainSuccess =
    lastOnChainSuccessAtMs === undefined
      ? undefined
      : now - lastOnChainSuccessAtMs;

  if (typeof hash === "string") {
    recordOnChainPushSuccess(hash);
  }

  capturePriceUpdateSuccess({
    ...context,
    cycleNumber,
    msSincePreviousOnChainSuccess,
  });
}

export function buildFeedStats(
  summaries: FeedStalenessSummary[],
  missingSourceCount: number,
): PushCycleFeedStats {
  const yesCount = summaries.filter((s) => s.condition === UpdateCondition.YES)
    .length;
  const earlyCount = summaries.filter(
    (s) => s.condition === UpdateCondition.EARLY,
  ).length;
  const noCount = summaries.filter((s) => s.condition === UpdateCondition.NO)
    .length;

  const staleWithLag = summaries.filter((s) => s.timeLagSec > 0);
  const maxStaleSec =
    staleWithLag.length === 0
      ? 0
      : Math.max(...staleWithLag.map((s) => s.timeLagSec));

  const stalestFeeds = [...summaries]
    .sort((a, b) => b.timeLagSec - a.timeLagSec)
    .slice(0, 5);

  return {
    yesCount,
    earlyCount,
    noCount,
    missingSourceCount,
    feedsToPush: yesCount + earlyCount,
    maxStaleSec,
    stalestFeeds,
  };
}
