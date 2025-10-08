import { Logger } from "pino";

export interface AdaptiveMarketConfig {
  // Minutes of inactivity before considering market closed
  inactivityThresholdMinutes: number;
  // Minutes to wait after detecting market open before starting to push
  delayAfterOpenMinutes: number;
  // Minutes before detecting market close to stop pushing
  delayBeforeCloseMinutes: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveMarketConfig = {
  inactivityThresholdMinutes: 60, // 1 hour
  delayAfterOpenMinutes: 15, // 15 minutes after market opens
  delayBeforeCloseMinutes: 15, // 15 minutes before market closes
};

export class AdaptiveMarketDetector {
  private config: AdaptiveMarketConfig;
  private logger: Logger;
  private lastPriceUpdateTime: number | null = null;
  private marketOpenTime: number | null = null;
  private marketClosedTime: number | null = null;
  private isMarketOpen: boolean = false;

  constructor(config: AdaptiveMarketConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Record that a price update was pushed
   * @param timestamp Unix timestamp when the price was pushed
   */
  recordPriceUpdate(timestamp: number = Date.now()): void {
    this.lastPriceUpdateTime = timestamp;
  }

  /**
   * Detect if market is open based on fresh price data from the source
   * Call this with the publish timestamp from Hermes to detect market activity
   * @param pricePublishTime Unix timestamp when the price was published by Pyth
   */
  detectMarketActivity(pricePublishTime: number): void {
    const now = Date.now();
    const priceAge = (now - pricePublishTime * 1000) / (1000 * 60); // minutes
    
    // Consider price "fresh" if it's less than 5 minutes old
    const isFreshPrice = priceAge < 5;
    
    if (isFreshPrice && !this.isMarketOpen) {
      // Fresh price detected - market is opening!
      this.marketOpenTime = now;
      this.isMarketOpen = true;
      this.marketClosedTime = null;
      
      this.logger.info(
        `Market detected as OPEN at ${new Date(now).toISOString()}. ` +
        `Fresh price detected (${priceAge.toFixed(1)} min old). ` +
        `Will start pushing prices in ${this.config.delayAfterOpenMinutes} minutes.`
      );
    }
  }

  /**
   * Check if we should push prices based on adaptive market detection
   * @returns true if we should push prices, false otherwise
   */
  shouldPushPrices(): boolean {
    const now = Date.now();
    
    // If market was never detected as open, don't push
    if (!this.isMarketOpen) {
      this.logger.debug("Market not detected as open yet, waiting for fresh price data...");
      return false;
    }

    // Check if we're in the delay period after market open
    if (this.marketOpenTime !== null) {
      const timeSinceMarketOpen = (now - this.marketOpenTime) / (1000 * 60); // minutes
      if (timeSinceMarketOpen < this.config.delayAfterOpenMinutes) {
        this.logger.debug(
          `Market recently opened, waiting ${(this.config.delayAfterOpenMinutes - timeSinceMarketOpen).toFixed(1)} more minutes before pushing`
        );
        return false;
      }
    }

    // Check if we should stop pushing due to inactivity (market closed)
    if (this.lastPriceUpdateTime !== null) {
      const timeSinceLastUpdate = (now - this.lastPriceUpdateTime) / (1000 * 60); // minutes
      
      if (timeSinceLastUpdate > this.config.inactivityThresholdMinutes) {
        // Market appears to be closed due to inactivity
        this.isMarketOpen = false;
        this.marketClosedTime = now;
        
        this.logger.info(
          `Market detected as CLOSED due to ${timeSinceLastUpdate.toFixed(1)} minutes of inactivity. ` +
          `Last update was at ${new Date(this.lastPriceUpdateTime).toISOString()}`
        );
        return false;
      }

      // Check if we should stop pushing before market closes (avoid end-of-day volatility)
      const timeUntilInactivityThreshold = this.config.inactivityThresholdMinutes - timeSinceLastUpdate;
      
      if (timeUntilInactivityThreshold <= this.config.delayBeforeCloseMinutes) {
        this.logger.info(
          `Stopping pushes to avoid market close volatility. ` +
          `Last update was ${timeSinceLastUpdate.toFixed(1)} minutes ago. ` +
          `Will declare market closed in ${timeUntilInactivityThreshold.toFixed(1)} more minutes.`
        );
        return false;  // Stop pushing 15 minutes before declaring market closed
      }
    }

    return true;
  }

  /**
   * Get the time until next potential market open (when we might start detecting activity)
   * @returns milliseconds until next potential market open
   */
  getTimeUntilNextPotentialOpen(): number {
    if (this.lastPriceUpdateTime === null) {
      return 0; // No data to predict
    }

    // Estimate next market open as 16 hours after last close (typical overnight gap)
    const estimatedNextOpen = this.lastPriceUpdateTime + (16 * 60 * 60 * 1000);
    return Math.max(0, estimatedNextOpen - Date.now());
  }

  /**
   * Get the time until market close detection (when we'll stop pushing due to inactivity)
   * @returns milliseconds until market close detection
   */
  getTimeUntilCloseDetection(): number {
    if (this.lastPriceUpdateTime === null || !this.isMarketOpen) {
      return 0;
    }

    const timeSinceLastUpdate = Date.now() - this.lastPriceUpdateTime;
    const timeUntilThreshold = (this.config.inactivityThresholdMinutes * 60 * 1000) - timeSinceLastUpdate;
    return Math.max(0, timeUntilThreshold);
  }

  /**
   * Get current market status
   * @returns Object with market status information
   */
  getMarketStatus(): {
    isOpen: boolean;
    lastUpdateTime: Date | null;
    timeSinceLastUpdate: number | null;
    timeUntilCloseDetection: number | null;
  } {
    const now = Date.now();
    const lastUpdateTime = this.lastPriceUpdateTime ? new Date(this.lastPriceUpdateTime) : null;
    const timeSinceLastUpdate = this.lastPriceUpdateTime ? (now - this.lastPriceUpdateTime) / (1000 * 60) : null;
    const timeUntilCloseDetection = this.getTimeUntilCloseDetection() / (1000 * 60);

    return {
      isOpen: this.isMarketOpen,
      lastUpdateTime,
      timeSinceLastUpdate,
      timeUntilCloseDetection: timeUntilCloseDetection > 0 ? timeUntilCloseDetection : null,
    };
  }

  /**
   * Reset the detector (useful for testing or manual reset)
   */
  reset(): void {
    this.lastPriceUpdateTime = null;
    this.marketOpenTime = null;
    this.marketClosedTime = null;
    this.isMarketOpen = false;
    this.logger.info("Market detector reset");
  }
}
