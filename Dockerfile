FROM node:20.8.0 AS builder

WORKDIR /opt/runner-container-hooks

COPY package.json package-lock.json packages/docker/package.json packages/docker/package-lock.json packages/hooklib/package.json packages/hooklib/package-lock.json packages/k8s/package.json packages/k8s/package-lock.json ./

RUN npm ci
RUN npm run bootstrap

COPY packages ./packages
RUN npm run build-all

FROM ghcr.io/actions/actions-runner:latest

ARG TARGETARCH=amd64

USER root

RUN apt-get update && apt-get install -y \
    apt-transport-https \
    ca-certificates \
    git \
    curl \
    gnupg \
    jq \
    lsb-release \
    sudo \
    && rm -rf /var/lib/apt/lists/*

RUN curl https://mise.run | sh
ENV PATH="/root/.local/bin:$PATH"
RUN /root/.local/bin/mise install --yes

ENV CI=true

# Default to 1450 to avoid MTU issues with VPNs
ENV DOCKER_MTU=1450

# Default to Docker container hooks
ENV ACTIONS_RUNNER_CONTAINER_HOOKS=/home/runner/docker/index.js

COPY --from=builder /opt/runner-container-hooks/packages/docker/dist/index.js /home/runner/docker/index.js
COPY --from=builder /opt/runner-container-hooks/packages/k8s/entrypoint.js /home/runner/k8s/index.js
COPY --from=builder /opt/runner-container-hooks/packages/k8s/lib /home/runner/k8s/lib
COPY --from=builder /opt/runner-container-hooks/packages/k8s/node_modules /home/runner/k8s/node_modules
RUN rm -rf /home/runner/k8s/node_modules/hooklib
COPY --from=builder /opt/runner-container-hooks/packages/hooklib /home/runner/k8s/node_modules/hooklib

USER runner

LABEL org.opencontainers.image.source=https://github.com/echohello-dev/runner-container-hooks
LABEL org.opencontainers.image.description="GitHub Action Runner Container Hooks"
LABEL org.opencontainers.image.licenses=MIT