#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import injective from "./injective/command";
import evm from "./evm/command";
import aptos from "./aptos/command";
import sui from "./sui/command";
import near from "./near/command";
import solana from "./solana/command";
import fuel from "./fuel/command";
import ton from "./ton/command";
import {
  enableMetrics,
  metricsPort,
  sentryDsn,
  sentryEnvironment,
} from "./options";
import { initSentry, setupSentryShutdownFlush } from "./sentry";

// Init from env before yargs runs so early failures are captured when DSN is set.
initSentry();
setupSentryShutdownFlush();

yargs(hideBin(process.argv))
  .parserConfiguration({
    "parse-numbers": false,
  })
  .config("config")
  .global("config")
  .middleware((argv) => {
    initSentry({
      dsn: argv["sentry-dsn"] as string | undefined,
      environment: argv["sentry-environment"] as string | undefined,
    });
    return argv;
  })
  .option("enable-metrics", enableMetrics["enable-metrics"])
  .option("metrics-port", metricsPort["metrics-port"])
  .option("sentry-dsn", sentryDsn["sentry-dsn"])
  .option("sentry-environment", sentryEnvironment["sentry-environment"])
  .command(evm)
  .command(fuel)
  .command(injective)
  .command(aptos)
  .command(sui)
  .command(near)
  .command(solana)
  .command(ton)
  .help().argv;
