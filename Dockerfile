FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node src ./src
COPY --chown=node:node docs ./docs
RUN mkdir -p /data && chown node:node /data
USER node
ENV DESIGNSIGNAL_DATA_DIR=/data DESIGNSIGNAL_HOST=0.0.0.0 DESIGNSIGNAL_PORT=3379 NODE_ENV=production
EXPOSE 3379
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3379/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/cli.mjs", "serve"]
