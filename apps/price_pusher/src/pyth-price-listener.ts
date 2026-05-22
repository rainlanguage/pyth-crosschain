import {
  HexString,
  HermesClient,
  PriceUpdate,
} from "@pythnetwork/hermes-client";
import { EventSource } from "eventsource";
import { PriceInfo, IPriceListener, PriceItem } from "./interface";
import { Logger } from "pino";
import { chunkArray, sleep } from "./utils";
import { captureHermesStreamError } from "./sentry";

type TimestampInMs = number & { readonly _: unique symbol };

type StreamState = {
  streamIndex: number;
  priceIds: HexString[];
  eventSource?: EventSource;
  reconnecting: boolean;
  consecutiveFailures: number;
};

function hermesStreamChunkSize(): number {
  const fromEnv = process.env.HERMES_STREAM_CHUNK_SIZE;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 15;
}

function parseHermesStreamError(error: Event): {
  message: string;
  statusCode?: number;
} {
  const err = error as Event & {
    message?: string;
    code?: number;
  };
  const message =
    typeof err.message === "string"
      ? err.message
      : "Hermes price stream error";
  const statusMatch = message.match(/\((\d{3})\)/);
  const statusCode =
    typeof err.code === "number"
      ? err.code
      : statusMatch
        ? Number(statusMatch[1])
        : undefined;
  return { message, statusCode };
}

export class PythPriceListener implements IPriceListener {
  private hermesClient: HermesClient;
  private priceIds: HexString[];
  private priceIdToAlias: Map<HexString, string>;
  private latestPriceInfo: Map<HexString, PriceInfo>;
  private logger: Logger;
  private lastUpdated: TimestampInMs | undefined;
  private healthCheckInterval?: NodeJS.Timeout;
  private streamStates: StreamState[] = [];
  private stopped = false;

  constructor(
    hermesClient: HermesClient,
    priceItems: PriceItem[],
    logger: Logger,
  ) {
    this.hermesClient = hermesClient;
    this.priceIds = priceItems.map((priceItem) => priceItem.id);
    this.priceIdToAlias = new Map(
      priceItems.map((priceItem) => [priceItem.id, priceItem.alias]),
    );
    this.latestPriceInfo = new Map();
    this.logger = logger;
  }

  async start() {
    this.stopped = false;
    await this.startListening();

    this.healthCheckInterval = setInterval(() => {
      if (
        this.lastUpdated === undefined ||
        this.lastUpdated < Date.now() - 30 * 1000
      ) {
        // throw new Error("Hermes Price feeds are not updating.");
      }
    }, 5000);
  }

  async startListening() {
    const chunkSize = hermesStreamChunkSize();
    const priceIdChunks =
      this.priceIds.length > chunkSize
        ? chunkArray(this.priceIds, chunkSize)
        : [this.priceIds];

    this.logger.info(
      {
        totalFeeds: this.priceIds.length,
        streamCount: priceIdChunks.length,
        feedsPerStream: chunkSize,
      },
      "Starting Hermes price streams.",
    );

    this.streamStates = priceIdChunks.map((priceIds, streamIndex) => ({
      streamIndex,
      priceIds,
      reconnecting: false,
      consecutiveFailures: 0,
    }));

    await Promise.all(
      this.streamStates.map((state) => this.openStream(state)),
    );
  }

  private async openStream(state: StreamState): Promise<void> {
    if (this.stopped) {
      return;
    }

    const { streamIndex, priceIds } = state;

    this.logger.info(
      { streamIndex, feedCount: priceIds.length },
      "Opening Hermes price stream.",
    );

    let eventSource: EventSource;
    try {
      eventSource = await this.hermesClient.getPriceUpdatesStream(priceIds, {
        parsed: true,
        ignoreInvalidPriceIds: true,
      });
    } catch (err) {
      state.consecutiveFailures += 1;
      const message =
        err instanceof Error ? err.message : "Failed to open Hermes stream";
      this.logger.error(
        { err, streamIndex, feedCount: priceIds.length },
        "Failed to create Hermes EventSource.",
      );
      captureHermesStreamError({
        streamIndex,
        feedCount: priceIds.length,
        totalFeeds: this.priceIds.length,
        message,
        consecutiveFailures: state.consecutiveFailures,
      });
      await this.scheduleReconnect(state);
      return;
    }

    state.eventSource = eventSource;
    state.consecutiveFailures = 0;

    eventSource.onmessage = (event: MessageEvent<string>) => {
      this.handlePriceMessage(event);
    };

    eventSource.onerror = (error: Event) => {
      void this.handleStreamError(state, error);
    };
  }

  private handlePriceMessage(event: MessageEvent<string>) {
    const priceUpdates = JSON.parse(event.data) as PriceUpdate;
    priceUpdates.parsed?.forEach((priceUpdate) => {
      this.logger.debug(
        {
          alias: this.priceIdToAlias.get(priceUpdate.id),
          priceId: priceUpdate.id,
        },
        "Received Hermes price update.",
      );

      const currentTime = Date.now() / 1000;
      const timeDiff = currentTime - priceUpdate.price.publish_time;

      const currentPrice =
        timeDiff > 24 * 60 * 60 ? undefined : priceUpdate.price;
      if (currentPrice === undefined) {
        this.logger.debug(
          { priceId: priceUpdate.id, ageSec: timeDiff },
          "Skipping Hermes price older than 24h.",
        );
        return;
      }

      const priceInfo: PriceInfo = {
        conf: currentPrice.conf,
        price: currentPrice.price,
        publishTime: currentPrice.publish_time,
      };

      this.latestPriceInfo.set(priceUpdate.id, priceInfo);
      this.lastUpdated = Date.now() as TimestampInMs;
    });
  }

  private async handleStreamError(
    state: StreamState,
    error: Event,
  ): Promise<void> {
    if (state.reconnecting || this.stopped) {
      return;
    }
    state.reconnecting = true;

    const { message, statusCode } = parseHermesStreamError(error);
    state.consecutiveFailures += 1;

    const readyState = state.eventSource?.readyState;
    state.eventSource?.close();
    state.eventSource = undefined;

    this.logger.error(
      {
        streamIndex: state.streamIndex,
        feedCount: state.priceIds.length,
        statusCode,
        readyState,
        consecutiveFailures: state.consecutiveFailures,
        errMessage: message,
      },
      "Error receiving updates from Hermes.",
    );

    captureHermesStreamError({
      streamIndex: state.streamIndex,
      feedCount: state.priceIds.length,
      totalFeeds: this.priceIds.length,
      message,
      statusCode,
      consecutiveFailures: state.consecutiveFailures,
    });

    await this.scheduleReconnect(state);
    state.reconnecting = false;
  }

  private async scheduleReconnect(state: StreamState): Promise<void> {
    if (this.stopped) {
      return;
    }

    const backoffSec = Math.min(
      60,
      5 * Math.pow(2, Math.min(state.consecutiveFailures - 1, 4)),
    );
    this.logger.warn(
      {
        streamIndex: state.streamIndex,
        backoffSec,
        consecutiveFailures: state.consecutiveFailures,
      },
      "Reconnecting to Hermes stream.",
    );
    await sleep(backoffSec * 1000);
    await this.openStream(state);
  }

  getLatestPriceInfo(priceId: HexString): PriceInfo | undefined {
    return this.latestPriceInfo.get(priceId);
  }

  async waitForFirstPriceUpdate(timeoutMs: number = 10000): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        if (this.latestPriceInfo.size > 0) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 100);
    });
  }

  cleanup() {
    this.stopped = true;
    for (const state of this.streamStates) {
      state.eventSource?.close();
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }
}
