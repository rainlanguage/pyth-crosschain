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
  blockerReason: string;
  priceDeviationPct?: number;
  confidenceRatioPct?: number;
};

type SkippedCycleRecord = {
  cycleNumber: number;
  atIso: string;
  cycleSkipReason: string;
  explanation: string;
  yesCount: number;
  earlyCount: number;
  noCount: number;
  missingSourceCount: number;
  maxStaleSec: number;
  feedsClosestToPush: FeedStalenessSummary[];
};

const MAX_SKIP_HISTORY = 10;
const recentSkippedCycles: SkippedCycleRecord[] = [];
let lastPushAttemptHadZeroConfirmations = false;
let lastPushAttemptChunksSkipped = 0;
let currentCycleConfirmedTxHashes: string[] = [];

function blockExplorerTxUrl(txHash: string): string {
  const prefix =
    process.env.BLOCK_EXPLORER_TX_URL ?? "https://basescan.org/tx/";
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const hash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;
  return `${normalized}${hash}`;
}

function formatPushCycleFinishedMessage(
  error: unknown | undefined,
  confirmedTxHashes: string[],
): string {
  if (error !== undefined) {
    if (confirmedTxHashes.length === 0) {
      return "Push cycle finished with error";
    }
    const links = confirmedTxHashes.map(blockExplorerTxUrl).join(", ");
    return `Push cycle finished with error — ${links}`;
  }
  if (confirmedTxHashes.length === 0) {
    return "Push cycle finished (no on-chain confirmation)";
  }
  return `Push cycle finished — ${confirmedTxHashes.map(blockExplorerTxUrl).join(", ")}`;
}

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
  currentCycleConfirmedTxHashes = [];

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
    capturePushGapDetected(pushingFrequencySec, msSinceLastSuccess);
  }

  return lastCycleStartedAtMs;
}

export type CycleSkipDiagnosis = {
  cycleSkipReason: string;
  explanation: string;
};

export function diagnoseCycleSkip(
  stats: PushCycleFeedStats,
  totalFeedCount: number,
): CycleSkipDiagnosis {
  if (stats.missingSourceCount === totalFeedCount && totalFeedCount > 0) {
    return {
      cycleSkipReason: "all_hermes_sources_unavailable",
      explanation:
        "No Hermes source prices available for configured feeds (market may be closed or Hermes stream stale).",
    };
  }

  if (stats.earlyCount > 0 && stats.yesCount === 0) {
    return {
      cycleSkipReason: "only_early_feeds_without_yes_trigger",
      explanation: `${stats.earlyCount} feed(s) met EARLY thresholds but none met YES. This pusher only submits a batch when at least one feed hits YES.`,
    };
  }

  if (stats.maxStaleSec < Number(process.env.SENTRY_INTERVAL_WARN_MIN_STALE_SEC ?? "240")) {
    return {
      cycleSkipReason: "all_feeds_fresh_enough_on_chain",
      explanation: `No feed exceeded the YES time_difference threshold (max Hermes−on-chain lag ${stats.maxStaleSec}s). Prices are considered fresh; no push required this cycle.`,
    };
  }

  const blockers = stats.stalestFeeds
    .map((f) => f.blockerReason)
    .filter((r) => r.includes("hermes_publish_time_older"));
  if (blockers.length > 0 && stats.yesCount === 0) {
    return {
      cycleSkipReason: "hermes_not_newer_than_on_chain",
      explanation:
        "Staleness is high but Hermes publish time is not ahead of on-chain for key feeds — waiting for newer Hermes updates.",
    };
  }

  return {
    cycleSkipReason: "thresholds_not_met",
    explanation: `No feed met YES thresholds (max lag ${stats.maxStaleSec}s). Check price_deviation and confidence_ratio vs config.`,
  };
}

function recordSkippedCycle(
  pushingFrequencySec: number,
  stats: PushCycleFeedStats,
  diagnosis: CycleSkipDiagnosis,
): void {
  recentSkippedCycles.push({
    cycleNumber,
    atIso: new Date().toISOString(),
    cycleSkipReason: diagnosis.cycleSkipReason,
    explanation: diagnosis.explanation,
    yesCount: stats.yesCount,
    earlyCount: stats.earlyCount,
    noCount: stats.noCount,
    missingSourceCount: stats.missingSourceCount,
    maxStaleSec: stats.maxStaleSec,
    feedsClosestToPush: stats.stalestFeeds,
  });
  if (recentSkippedCycles.length > MAX_SKIP_HISTORY) {
    recentSkippedCycles.shift();
  }
}

export function capturePushGapDetected(
  pushingFrequencySec: number,
  msSinceLastSuccess: number,
): void {
  if (!monitoringEnabled()) {
    return;
  }

  const maxMsSinceOnChainSuccess =
    getMaxMsSinceOnChainSuccess(pushingFrequencySec);
  const lastSkip = recentSkippedCycles[recentSkippedCycles.length - 1];

  Sentry.captureMessage("Push gap detected — no on-chain update in time window", {
    level: "warning",
    extra: {
      cycleNumber,
      msSinceLastOnChainSuccess: msSinceLastSuccess,
      maxMsSinceOnChainSuccess,
      gapMinutes: Math.round(msSinceLastSuccess / 60000),
      targetIntervalMinutes: pushingFrequencySec / 60,
      excessMs: msSinceLastSuccess - maxMsSinceOnChainSuccess,
      lastOnChainSuccessTxHash,
      whyNoPushRecently: lastSkip
        ? {
            lastSkippedCycle: lastSkip,
            recentSkippedCycles: [...recentSkippedCycles],
          }
        : {
            note: "No skipped-cycle history yet this process lifetime",
          },
      lastPushAttemptHadZeroConfirmations,
      lastPushAttemptChunksSkipped,
      likelyCauses: buildLikelyCausesSummary(
        msSinceLastSuccess,
        lastSkip,
        lastPushAttemptHadZeroConfirmations,
      ),
    },
  });
}

function buildLikelyCausesSummary(
  msSinceLastSuccess: number,
  lastSkip: SkippedCycleRecord | undefined,
  pushAttemptZeroConfirm: boolean,
): string[] {
  const causes: string[] = [];

  if (pushAttemptZeroConfirm) {
    causes.push(
      "Push was attempted but every chunk failed simulation or receipt (see Price update chunk skipped events).",
    );
  }

  if (lastSkip?.cycleSkipReason === "all_feeds_fresh_enough_on_chain") {
    causes.push(
      "Pusher decided on-chain prices were fresh enough — Hermes−on-chain lag below time_difference (expected right after a successful push).",
    );
  }

  if (lastSkip?.cycleSkipReason === "only_early_feeds_without_yes_trigger") {
    causes.push(
      "Only EARLY feeds needed updates; no YES trigger to start a batch.",
    );
  }

  if (lastSkip?.cycleSkipReason === "all_hermes_sources_unavailable") {
    causes.push("Hermes had no fresh source prices (weekend/market closed?).");
  }

  if (lastSkip?.cycleSkipReason === "hermes_not_newer_than_on_chain") {
    causes.push("Hermes price is older than what is already on-chain.");
  }

  if (causes.length === 0) {
    causes.push(
      `No on-chain confirmation for ${Math.round(msSinceLastSuccess / 60000)} min — inspect recentSkippedCycles in this event.`,
    );
  }

  return causes;
}

export function capturePushCycleNoPush(
  pushingFrequencySec: number,
  stats: PushCycleFeedStats,
  totalFeedCount: number,
): void {
  if (!monitoringEnabled()) {
    return;
  }

  const diagnosis = diagnoseCycleSkip(stats, totalFeedCount);
  recordSkippedCycle(pushingFrequencySec, stats, diagnosis);

  Sentry.captureMessage("Push cycle skipped — no on-chain update", {
    level: "info",
    extra: {
      cycleNumber,
      cycleSkipReason: diagnosis.cycleSkipReason,
      explanation: diagnosis.explanation,
      pushingFrequencySec,
      ...stats,
      msSinceLastOnChainSuccess:
        lastOnChainSuccessAtMs === undefined
          ? undefined
          : Date.now() - lastOnChainSuccessAtMs,
    },
  });
}

export function recordPushAttemptResult(
  chunksConfirmed: number,
  chunksSkipped: number,
): void {
  lastPushAttemptHadZeroConfirmations = chunksConfirmed === 0;
  lastPushAttemptChunksSkipped = chunksSkipped;

  if (!monitoringEnabled() || chunksConfirmed > 0) {
    return;
  }

  Sentry.captureMessage("Push attempted but no chunk confirmed on-chain", {
    level: "warning",
    extra: {
      cycleNumber,
      chunksConfirmed,
      chunksSkipped,
      msSinceLastOnChainSuccess:
        lastOnChainSuccessAtMs === undefined
          ? undefined
          : Date.now() - lastOnChainSuccessAtMs,
      recentSkippedCycles: [...recentSkippedCycles],
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

  const confirmedTxHashes = [...currentCycleConfirmedTxHashes];
  const basescanUrls = confirmedTxHashes.map(blockExplorerTxUrl);

  Sentry.captureMessage(
    formatPushCycleFinishedMessage(context.error, confirmedTxHashes),
    {
      level: context.error ? "error" : "info",
      extra: {
        cycleNumber,
        pushingFrequencySec,
        pushDurationMs: context.pushDurationMs,
        feedsToPush: context.feedsToPush,
        chunksAttempted: context.chunksAttempted,
        chunksConfirmed: context.chunksConfirmed,
        transactionHashes: confirmedTxHashes,
        basescanUrls,
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
  lastPushAttemptHadZeroConfirmations = false;
  lastPushAttemptChunksSkipped = 0;
  currentCycleConfirmedTxHashes.push(txHash);
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
