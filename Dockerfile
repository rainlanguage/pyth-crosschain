FROM node:22.14

# set git sha and docker tag form build time arg to run time env in container
ARG GIT_SHA
ARG DOCKER_CHANNEL
ENV GIT_COMMIT=$GIT_SHA
ENV DOCKER_TAG=$DOCKER_CHANNEL

# Sentry: set SENTRY_DSN at deploy time (do not bake into the image).
# SENTRY_ENVIRONMENT — optional (e.g. production, staging)
# SENTRY_PUSH_CYCLE_MONITORING — set "false" to disable all push-cycle / chunk Sentry events
ENV SENTRY_MIN_LOG_LEVEL=error
ENV SENTRY_CAPTURE_SUCCESS_UPDATES=false
ENV SENTRY_INTERVAL_WARN_MIN_STALE_SEC=240
ENV SENTRY_MAX_MS_SINCE_ON_CHAIN_SUCCESS=375000
# SENTRY_INTERVAL_WARN_ALWAYS — set "true" to warn on push gaps even when market looks idle
# BLOCK_EXPLORER_TX_URL — tx link prefix in "Push cycle finished" (default https://basescan.org/tx/)

WORKDIR /price-pusher
ADD . .

WORKDIR apps/price_pusher
CMD ["bash", "-c", "npm run start evm -- \
    --price-config-file ./price-config.stable.sample.yaml \
    --endpoint \"${ENDPOINT}\" \
    --pyth-contract-address \"${PYTH_CONTRACT_ADDRESS}\" \
    --price-service-endpoint \"${PRICE_SERVICE_ENDPOINT}\" \
    --mnemonic-file <(echo \"${MNEMONIC}\") \
    --pushing-frequency \"${PUSHING_FREQUENCY:-300}\" \
    --polling-frequency \"${POLLING_FREQUENCY:-5}\" \
    --gas-limit \"${GAS_LIMIT:-6000000}\" \
    --update-fee-multiplier \"${UPDATE_FEE_MULTIPLIER:-1.2}\" \
    --price-ids-process-chunk-size \"${PRICE_IDS_PROCESS_CHUNK_SIZE:-25}\" \
    --override-gas-price-multiplier \"${GAS_PRICE_MULTIPLIER:-1.2}\" \
    --override-gas-price-multiplier-cap \"${GAS_PRICE_MULTIPLIER_CAP:-5}\""]
