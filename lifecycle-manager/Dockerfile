FROM node:23-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json .
COPY package-lock.json .

RUN npm install

COPY . .

# Run with tsx directly as per package.json devDependencies
CMD ["npx", "tsx", "index.ts"]
