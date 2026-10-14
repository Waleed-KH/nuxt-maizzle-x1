# Builds on Debian (glibc) and runs on Alpine (musl), which is how the app this
# reproduction comes from is deployed. See README.md, "Native bindings".
#
#   docker build -t nuxt-maizzle-x1 .
#   docker run --rm -p 3000:3000 nuxt-maizzle-x1      then GET http://localhost:3000/api/render
#
# The build stage on its own, to try the workarounds on Linux:
#   docker build --target build -t nuxt-maizzle-x1:build .
#   docker run --rm nuxt-maizzle-x1:build node scripts/build.mjs --probe --disable=cjs-exclude

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable pnpm
COPY . .
# pnpm installs only the native packages for the machine it runs on; the runtime
# is musl, so ask for those too.
RUN pnpm install --frozen-lockfile --libc=glibc --libc=musl
# The bindings to trace are the runtime's (musl), not this stage's (glibc).
# An ARG reaches the RUN below only, not containers started from this stage.
ARG FORCE_MUSL=true
RUN node scripts/build.mjs

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build /app/.output ./.output
ENV NODE_ENV=production
EXPOSE 3000
# Started from the directory holding .output: the server finds its packages
# in .output/server (server/utils/paths.ts).
CMD ["node", ".output/server/index.mjs"]