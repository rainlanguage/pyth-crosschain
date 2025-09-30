FROM node:22.14

# set git sha and docker tag form build time arg to run time env in container
ARG GIT_SHA
ARG DOCKER_CHANNEL
ENV GIT_COMMIT=$GIT_SHA
ENV DOCKER_TAG=$DOCKER_CHANNEL

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
    --override-gas-price-multiplier \"${GAS_PRICE_MULTIPLIER:-1.1}\""]
