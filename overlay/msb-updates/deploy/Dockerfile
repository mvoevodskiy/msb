FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8787
ENV MSB_UPDATES_DATA=/data
ENV BOT_MODE=webhook
EXPOSE 8787

VOLUME ["/data"]
CMD ["node", "bin/serve.mjs"]
