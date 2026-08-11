FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

COPY *.ts ./
COPY auth ./auth
COPY public ./public
COPY examples ./examples
COPY skill ./skill

RUN mkdir -p /app/state

ENV PORT=39191
EXPOSE 39191

CMD ["bun", "server.ts"]
