import { HexString } from "@pythnetwork/hermes-client";
import Joi from "joi";
import YAML from "yaml";
import fs from "fs";
import { Logger } from "pino";
import { DurationInSeconds, PctNumber, removeLeading0x } from "./utils";
import { PriceInfo } from "./interface";

const PriceConfigFileSchema: Joi.Schema = Joi.array()
  .items(
    Joi.object({
      alias: Joi.string().required(),
      id: Joi.string()
        .regex(/^(0x)?[a-f0-9]{64}$/)
        .required(),
      time_difference: Joi.number().required(),
      price_deviation: Joi.number().required(),
      confidence_ratio: Joi.number().required(),
      early_update: Joi.object({
        time_difference: Joi.number().optional(),
        price_deviation: Joi.number().optional(),
        confidence_ratio: Joi.number().optional(),
      }).optional(),
    }),
  )
  .unique("id")
  .unique("alias")
  .required();

export type PriceConfig = {
  alias: string;
  id: HexString;
  timeDifference: DurationInSeconds;
  priceDeviation: PctNumber;
  confidenceRatio: PctNumber;

  // An early update happens when another price has met the conditions to be pushed, so this
  // price can be included in a batch update for minimal gas cost.
  // By default, every price feed will be early updated in a batch if any other price update triggers
  // the conditions. This configuration will typically minimize gas usage.
  //
  // However, if you would like to customize this behavior, set `customEarlyUpdate: true` in your config
  // for the price feed, then set the specific conditions (time / price / confidence) under which you would
  // like the early update to trigger.
  customEarlyUpdate: boolean | undefined;
  earlyUpdateTimeDifference: DurationInSeconds | undefined;
  earlyUpdatePriceDeviation: PctNumber | undefined;
  earlyUpdateConfidenceRatio: PctNumber | undefined;
};

export function readPriceConfigFile(path: string): PriceConfig[] {
  const priceConfigs = YAML.parse(fs.readFileSync(path, "utf-8"));
  const validationResult = PriceConfigFileSchema.validate(priceConfigs);

  if (validationResult.error !== undefined) {
    throw validationResult.error;
  }

  return (priceConfigs as any[]).map((priceConfigRaw) => {
    const priceConfig: PriceConfig = {
      alias: priceConfigRaw.alias,
      id: removeLeading0x(priceConfigRaw.id),
      timeDifference: priceConfigRaw.time_difference,
      priceDeviation: priceConfigRaw.price_deviation,
      confidenceRatio: priceConfigRaw.confidence_ratio,

      customEarlyUpdate: priceConfigRaw.early_update !== undefined,
      earlyUpdateTimeDifference: priceConfigRaw.early_update?.time_difference,
      earlyUpdatePriceDeviation: priceConfigRaw.early_update?.price_deviation,
      earlyUpdateConfidenceRatio: priceConfigRaw.early_update?.confidence_ratio,
    };
    return priceConfig;
  });
}

export enum UpdateCondition {
  // This price feed must be updated
  YES,
  // This price feed may be updated as part of a larger batch
  EARLY,
  // This price feed shouldn't be updated
  NO,
}

export type FeedUpdateAnalysis = {
  condition: UpdateCondition;
  timeLagSec: number;
  blockerReason: string;
  priceDeviationPct?: number;
  confidenceRatioPct?: number;
};

export function analyzeFeedUpdate(
  priceConfig: PriceConfig,
  sourceLatestPrice: PriceInfo | undefined,
  targetLatestPrice: PriceInfo | undefined,
): FeedUpdateAnalysis {
  if (sourceLatestPrice === undefined) {
    return {
      condition: UpdateCondition.NO,
      timeLagSec: 0,
      blockerReason: "hermes_source_unavailable",
    };
  }

  if (targetLatestPrice === undefined) {
    return {
      condition: UpdateCondition.YES,
      timeLagSec: Number.MAX_SAFE_INTEGER,
      blockerReason: "would_trigger_yes_feed_missing_on_chain",
    };
  }

  if (sourceLatestPrice.publishTime < targetLatestPrice.publishTime) {
    return {
      condition: UpdateCondition.NO,
      timeLagSec: 0,
      blockerReason: "hermes_publish_time_older_than_on_chain",
    };
  }

  const timeLagSec =
    sourceLatestPrice.publishTime - targetLatestPrice.publishTime;

  const priceDeviationPct =
    (Math.abs(
      Number(sourceLatestPrice.price) - Number(targetLatestPrice.price),
    ) /
      Number(targetLatestPrice.price)) *
    100;
  const confidenceRatioPct = Math.abs(
    (Number(sourceLatestPrice.conf) / Number(sourceLatestPrice.price)) * 100,
  );

  const timeMet = timeLagSec >= priceConfig.timeDifference;
  const deviationMet = priceDeviationPct >= priceConfig.priceDeviation;
  const confidenceMet = confidenceRatioPct >= priceConfig.confidenceRatio;

  if (timeMet || deviationMet || confidenceMet) {
    const triggers = [
      timeMet ? `time_lag_${timeLagSec}s>=${priceConfig.timeDifference}s` : null,
      deviationMet
        ? `deviation_${priceDeviationPct.toFixed(4)}%>=${priceConfig.priceDeviation}%`
        : null,
      confidenceMet
        ? `confidence_${confidenceRatioPct.toFixed(4)}%>=${priceConfig.confidenceRatio}%`
        : null,
    ].filter(Boolean);
    return {
      condition: UpdateCondition.YES,
      timeLagSec,
      blockerReason: `yes_threshold_met:${triggers.join(",")}`,
      priceDeviationPct,
      confidenceRatioPct,
    };
  }

  const earlyTimeMet =
    priceConfig.earlyUpdateTimeDifference !== undefined &&
    timeLagSec >= priceConfig.earlyUpdateTimeDifference;
  const earlyDeviationMet =
    priceConfig.earlyUpdatePriceDeviation !== undefined &&
    priceDeviationPct >= priceConfig.earlyUpdatePriceDeviation;
  const earlyConfidenceMet =
    priceConfig.earlyUpdateConfidenceRatio !== undefined &&
    confidenceRatioPct >= priceConfig.earlyUpdateConfidenceRatio;

  if (
    priceConfig.customEarlyUpdate === undefined ||
    !priceConfig.customEarlyUpdate ||
    earlyTimeMet ||
    earlyDeviationMet ||
    earlyConfidenceMet
  ) {
    return {
      condition: UpdateCondition.EARLY,
      timeLagSec,
      blockerReason:
        "early_only_waits_for_another_feed_to_hit_yes_before_batch_push",
      priceDeviationPct,
      confidenceRatioPct,
    };
  }

  return {
    condition: UpdateCondition.NO,
    timeLagSec,
    blockerReason: `below_all_thresholds:time_lag_${timeLagSec}s<${priceConfig.timeDifference}s,deviation_${priceDeviationPct.toFixed(4)}%<${priceConfig.priceDeviation}%,confidence_${confidenceRatioPct.toFixed(4)}%<${priceConfig.confidenceRatio}%`,
    priceDeviationPct,
    confidenceRatioPct,
  };
}

/**
 * Checks whether on-chain price needs to be updated with the latest pyth price information.
 *
 * @param priceConfig Config of the price feed to check
 * @returns True if the on-chain price needs to be updated.
 */
export function shouldUpdate(
  priceConfig: PriceConfig,
  sourceLatestPrice: PriceInfo | undefined,
  targetLatestPrice: PriceInfo | undefined,
  logger: Logger,
): UpdateCondition {
  const priceId = priceConfig.id;
  const analysis = analyzeFeedUpdate(
    priceConfig,
    sourceLatestPrice,
    targetLatestPrice,
  );

  if (sourceLatestPrice === undefined) {
    logger.info(
      `${priceConfig.alias} (${priceId}) is not available on the source network. Ignoring it.`,
    );
    return analysis.condition;
  }

  if (targetLatestPrice === undefined) {
    logger.info(
      `${priceConfig.alias} (${priceId}) is not available on the target network. Pushing the price.`,
    );
    return analysis.condition;
  }

  logger.info(
    {
      sourcePrice: sourceLatestPrice,
      targetPrice: targetLatestPrice,
      symbol: priceConfig.alias,
      blockerReason: analysis.blockerReason,
    },
    `Analyzing price ${priceConfig.alias} (${priceId}). ` +
      `Time difference: ${analysis.timeLagSec} (< ${priceConfig.timeDifference}? / early: < ${priceConfig.earlyUpdateTimeDifference}) OR ` +
      `Price deviation: ${analysis.priceDeviationPct?.toFixed(5)}% (< ${
        priceConfig.priceDeviation
      }%? / early: < ${priceConfig.earlyUpdatePriceDeviation}%?) OR ` +
      `Confidence ratio: ${analysis.confidenceRatioPct?.toFixed(5)}% (< ${
        priceConfig.confidenceRatio
      }%? / early: < ${priceConfig.earlyUpdateConfidenceRatio}%?)`,
  );

  return analysis.condition;
}
