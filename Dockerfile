FROM node:22.14

# set git sha and docker tag form build time arg to run time env in container
ARG GIT_SHA
ARG DOCKER_CHANNEL
ENV GIT_COMMIT=$GIT_SHA
ENV DOCKER_TAG=$DOCKER_CHANNEL
# Optional Sentry env: SENTRY_DSN, SENTRY_ENVIRONMENT,
# SENTRY_CAPTURE_SUCCESS_UPDATES ("false" to disable), SENTRY_PUSH_CYCLE_MONITORING ("false" to disable),
# SENTRY_MAX_MS_SINCE_ON_CHAIN_SUCCESS (ms, default 125% of PUSHING_FREQUENCY),
# SENTRY_INTERVAL_WARN_MIN_STALE_SEC (default 240; suppress gap warnings when market idle),
# SENTRY_INTERVAL_WARN_ALWAYS ("true" to warn even when no feeds were stale).

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
    --gas-limit \"${GAS_LIMIT:-4000000}\" \
    --update-fee-multiplier \"${UPDATE_FEE_MULTIPLIER:-1.2}\" \
    --price-ids-process-chunk-size \"${PRICE_IDS_PROCESS_CHUNK_SIZE:-10}\" \
    --override-gas-price-multiplier \"${GAS_PRICE_MULTIPLIER:-1.1}\" \
    --override-gas-price-multiplier-cap \"${GAS_PRICE_MULTIPLIER_CAP:-5}\""]
