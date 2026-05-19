import { UnixTimestamp } from "@pythnetwork/hermes-client";
import { DurationInSeconds, sleep } from "./utils";
import { IPriceListener, IPricePusher } from "./interface";
import {
  analyzeFeedUpdate,
  PriceConfig,
  shouldUpdate,
  UpdateCondition,
} from "./price-config";
import { Logger } from "pino";
import { PricePusherMetrics } from "./metrics";
import {
  buildFeedStats,
  capturePushCycleFinished,
  capturePushCycleNoPush,
  capturePushCycleOverrun,
  capturePushCycleTriggered,
  markPushCycleStarted,
  recordPushCycleContext,
  type FeedStalenessSummary,
} from "./push-monitoring";

/** .PRE / .POST only push on YES, not as EARLY riders on regular-session txs. */
function shouldIncludeFeedInPush(
  priceConfig: PriceConfig,
  condition: UpdateCondition,
): boolean {
  if (condition === UpdateCondition.YES) {
    return true;
  }
  if (condition === UpdateCondition.EARLY) {
    const { alias } = priceConfig;
    return !alias.endsWith(".PRE") && !alias.endsWith(".POST");
  }
  return false;
}

export class Controller {
  private pushingFrequency: DurationInSeconds;
  private metrics?: PricePusherMetrics;

  constructor(
    private priceConfigs: PriceConfig[],
    private sourcePriceListener: IPriceListener,
    private targetPriceListener: IPriceListener,
    private targetChainPricePusher: IPricePusher,
    private logger: Logger,
    config: {
      pushingFrequency: DurationInSeconds;
      metrics?: PricePusherMetrics;
    },
  ) {
    this.pushingFrequency = config.pushingFrequency;
    this.metrics = config.metrics;

    // Set the number of price feeds if metrics are enabled
    this.metrics?.setPriceFeedsTotal(this.priceConfigs.length);
  }

  async start() {
    // start the listeners
    await this.sourcePriceListener.start();
    await this.targetPriceListener.start();

    // wait for the listeners to get updated. There could be a restart
    // before this run and we need to respect the cooldown duration as
    // their might be a message sent before.
    await sleep(this.pushingFrequency * 1000);

    for (;;) {
      const cycleStartedAtMs = markPushCycleStarted(this.pushingFrequency);

      // Push when at least one feed is YES. Regular feeds may also ride along as EARLY;
      // .PRE / .POST are never batched as EARLY (only when they hit YES on their own).
      let pushThresholdMet = false;
      const pricesToPush: PriceConfig[] = [];
      const pubTimesToPush: UnixTimestamp[] = [];
      const feedSummaries: FeedStalenessSummary[] = [];
      let missingSourceCount = 0;

      for (const priceConfig of this.priceConfigs) {
        const priceId = priceConfig.id;
        const alias = priceConfig.alias;

        const targetLatestPrice =
          this.targetPriceListener.getLatestPriceInfo(priceId);
        const sourceLatestPrice =
          this.sourcePriceListener.getLatestPriceInfo(priceId);

        if (this.metrics && targetLatestPrice && sourceLatestPrice) {
          this.metrics.updateTimestamps(
            priceId,
            alias,
            targetLatestPrice.publishTime,
            sourceLatestPrice.publishTime,
            priceConfig.timeDifference,
          );
          this.metrics.updatePriceValues(
            priceId,
            alias,
            sourceLatestPrice.price,
            targetLatestPrice.price,
          );
        }

        const feedAnalysis = analyzeFeedUpdate(
          priceConfig,
          sourceLatestPrice,
          targetLatestPrice,
        );
        const priceShouldUpdate = shouldUpdate(
          priceConfig,
          sourceLatestPrice,
          targetLatestPrice,
          this.logger,
        );

        if (sourceLatestPrice === undefined) {
          missingSourceCount += 1;
        }

        feedSummaries.push({
          alias,
          timeLagSec: feedAnalysis.timeLagSec,
          condition: priceShouldUpdate,
          blockerReason: feedAnalysis.blockerReason,
          priceDeviationPct: feedAnalysis.priceDeviationPct,
          confidenceRatioPct: feedAnalysis.confidenceRatioPct,
        });

        // Record update condition in metrics
        if (this.metrics) {
          this.metrics.recordUpdateCondition(priceId, alias, priceShouldUpdate);
        }

        if (priceShouldUpdate == UpdateCondition.YES) {
          pushThresholdMet = true;
        }

        if (shouldIncludeFeedInPush(priceConfig, priceShouldUpdate)) {
          pricesToPush.push(priceConfig);
          pubTimesToPush.push((targetLatestPrice?.publishTime || 0) + 1);
        }
      }

      const feedStats = buildFeedStats(feedSummaries, missingSourceCount);

      if (pushThresholdMet) {
        capturePushCycleTriggered(
          this.pushingFrequency,
          feedStats,
          cycleStartedAtMs,
        );

        // When updates are split across multiple on-chain txs, push the most stale feeds first.
        pricesToPush.sort((a, b) => {
          const targetA = this.targetPriceListener.getLatestPriceInfo(a.id);
          const targetB = this.targetPriceListener.getLatestPriceInfo(b.id);
          const sourceA = this.sourcePriceListener.getLatestPriceInfo(a.id);
          const sourceB = this.sourcePriceListener.getLatestPriceInfo(b.id);
          const staleA =
            (sourceA?.publishTime ?? 0) - (targetA?.publishTime ?? 0);
          const staleB =
            (sourceB?.publishTime ?? 0) - (targetB?.publishTime ?? 0);
          return staleB - staleA;
        });

        this.logger.info(
          {
            priceIds: pricesToPush.map((priceConfig) => ({
              id: priceConfig.id,
              alias: priceConfig.alias,
            })),
          },
          "Some of the checks triggered pushing update. Will push the updates for some feeds.",
        );

        // note that the priceIds are without leading "0x"
        const priceIds = pricesToPush.map((priceConfig) => priceConfig.id);
        const pushStartedAtMs = Date.now();

        try {
          await this.targetChainPricePusher.updatePriceFeed(
            priceIds,
            pubTimesToPush,
          );

          capturePushCycleFinished(this.pushingFrequency, {
            feedsToPush: priceIds.length,
            pushDurationMs: Date.now() - pushStartedAtMs,
          });

          // Record successful updates
          if (this.metrics) {
            for (const config of pricesToPush) {
              const triggerValue =
                shouldUpdate(
                  config,
                  this.sourcePriceListener.getLatestPriceInfo(config.id),
                  this.targetPriceListener.getLatestPriceInfo(config.id),
                  this.logger,
                ) === UpdateCondition.YES
                  ? "yes"
                  : "early";

              this.metrics.recordPriceUpdate(
                config.id,
                config.alias,
                triggerValue,
              );
            }
          }
        } catch (error) {
          capturePushCycleFinished(this.pushingFrequency, {
            feedsToPush: priceIds.length,
            pushDurationMs: Date.now() - pushStartedAtMs,
            error,
          });

          this.logger.error(
            { error, priceIds },
            "Error pushing price updates to chain",
          );

          // Record errors in metrics
          if (this.metrics) {
            for (const config of pricesToPush) {
              const triggerValue =
                shouldUpdate(
                  config,
                  this.sourcePriceListener.getLatestPriceInfo(config.id),
                  this.targetPriceListener.getLatestPriceInfo(config.id),
                  this.logger,
                ) === UpdateCondition.YES
                  ? "yes"
                  : "early";

              this.metrics.recordPriceUpdateError(
                config.id,
                config.alias,
                triggerValue,
              );
            }
          }
        }
      } else {
        capturePushCycleNoPush(
          this.pushingFrequency,
          feedStats,
          feedSummaries.length,
        );
        this.logger.info("None of the checks were triggered. No push needed.");
      }

      // Sleep only the remainder of pushing-frequency so a long multi-chunk push
      // does not add a full extra interval on top of push duration (e.g. 5m push + 5m sleep = 10m).
      const cycleElapsedMs = Date.now() - cycleStartedAtMs;
      if (cycleElapsedMs > this.pushingFrequency * 1000) {
        capturePushCycleOverrun(this.pushingFrequency, cycleElapsedMs);
      }
      const sleepMs = Math.max(
        0,
        this.pushingFrequency * 1000 - cycleElapsedMs,
      );
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }

      recordPushCycleContext(pushThresholdMet, feedStats.maxStaleSec);
    }
  }
}
