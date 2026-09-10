FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /repo
COPY . .
WORKDIR /repo/cloud
RUN npm install --omit=dev

ENV CLOUD_DATA_DIR=/data
ENV JOB_APPLICATION_AGENT_STATE_DIR=/data/skill-state
ENV HOST=127.0.0.1
ENV PORT=8787
ENV CLOUD_EMBED_WORKER=1
ENV PLAYWRIGHT_HEADLESS=1

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "src/server.mjs"]
