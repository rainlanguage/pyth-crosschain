import {
  HexString,
  HermesClient,
  PriceUpdate,
} from "@pythnetwork/hermes-client";
import { PriceInfo, IPriceListener, PriceItem } from "./interface";
import { Logger } from "pino";
import { sleep } from "./utils";

type TimestampInMs = number & { readonly _: unique symbol };

export class PythPriceListener implements IPriceListener {
  private hermesClient: HermesClient;
  private priceIds: HexString[];
  private priceIdToAlias: Map<HexString, string>;
  private latestPriceInfo: Map<HexString, PriceInfo>;
  private logger: Logger;
  private lastUpdated: TimestampInMs | undefined;
  private healthCheckInterval?: NodeJS.Timeout;

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

  // This method should be awaited on and once it finishes it has the latest value
  // for the given price feeds (if they exist).
  async start() {
    await this.startListening();

    // Store health check interval reference
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
    this.logger.info(
      { priceIds: this.priceIds },
      `Starting to listen for price updates from Hermes for ${this.priceIds.length} price feeds.`,
    );

    const eventSource = await this.hermesClient.getPriceUpdatesStream(
      this.priceIds,
      {
        parsed: true,
        ignoreInvalidPriceIds: true,
      },
    );
    this.logger.info("Hermes price stream connected, waiting for messages");
    eventSource.onmessage = (event: MessageEvent<string>) => {
      const priceUpdates = JSON.parse(event.data) as PriceUpdate;
      priceUpdates.parsed?.forEach((priceUpdate) => {
        this.logger.debug(
          `Received new price feed update from Pyth price service: ${this.priceIdToAlias.get(
            priceUpdate.id,
          )} ${priceUpdate.id}`,
        );

        // Consider price to be currently available if it is not older than 24 hours
        const currentTime = Date.now() / 1000;
        const timeDiff = currentTime - priceUpdate.price.publish_time;
        this.logger.debug(
          {
            priceId: priceUpdate.id,
            currentTime,
            publishTime: priceUpdate.price.publish_time,
            timeDiffSeconds: timeDiff,
          },
          "Hermes price age check",
        );

        const currentPrice =
          timeDiff > 24 * 60 * 60 // 24 hours in seconds
            ? undefined
            : priceUpdate.price;
        if (currentPrice === undefined) {
          this.logger.debug(
            { priceId: priceUpdate.id, timeDiffSeconds: timeDiff },
            "Skipping Hermes price older than 24 hours",
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
    };

    eventSource.onerror = async (error: Event) => {
      this.logger.error(
        {
          readyState: eventSource.readyState,
          eventType: error.type,
        },
        "Error receiving updates from Hermes",
      );
      eventSource.close();
      await sleep(5000); // Wait a bit before trying to reconnect
      this.startListening(); // Attempt to restart the listener
    };
  }

  getLatestPriceInfo(priceId: HexString): PriceInfo | undefined {
    return this.latestPriceInfo.get(priceId);
  }

  // Wait for the first price update to be received
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
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }
}
