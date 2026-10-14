# nuxt-maizzle-x1

Reproduction for [nitrojs/nitro#4754](https://github.com/nitrojs/nitro/issues/4754), and a record of everything else the Nitro build needed before `.output` could render an email.

A Nuxt 4 app renders emails with [Maizzle](https://maizzle.com) 6 at request time ([`server/api/render.get.ts`](server/api/render.get.ts)). Maizzle is a build tool the server runs: each render starts a Vite SSR server, compiles a Vue SFC and runs Tailwind through PostCSS. So Vite, Rolldown, Tailwind, lightningcss and the Vue compiler are all runtime dependencies of the server, which Nitro has to copy into `.output/server/node_modules` by tracing.

With the workarounds in [`build/workarounds.ts`](build/workarounds.ts) it builds and renders. Each workaround can be switched off to see what it covers.

## Run it

```sh
pnpm install
pnpm build          # all workarounds on
pnpm check          # runs .output in isolation and renders an email through it
```

`pnpm check` copies `.output` into a fresh temporary directory, with no `node_modules` above it to supply what the build missed, and starts it without `NODE_PATH`. pnpm points `NODE_PATH` at its whole store when it runs a script, and Tailwind's resolver honours it, which would also hide a missing package. It then calls `GET /api/render` and checks that the email came back styled.

`scripts/build.mjs` options:

| | |
|---|---|
| `--disable=<name>[,<name>]` or `--disable=all` | switch workarounds off (names below) |
| `--heap=<MB>` | cap the V8 heap, as on a CI runner |
| `--probe` | report the modules Rollup parsed and the peak heap of the Nitro build ([`build/probe.ts`](build/probe.ts)) |

```sh
node scripts/build.mjs --probe --disable=cjs-exclude && pnpm check
```

On Linux, through Docker:

```sh
docker build -t nuxt-maizzle-x1 .                     # Debian build stage, Alpine runtime
docker run --rm -p 3000:3000 nuxt-maizzle-x1          # then GET http://localhost:3000/api/render

docker build --target build -t nuxt-maizzle-x1:build .
docker run --rm nuxt-maizzle-x1:build sh -c "node scripts/build.mjs --probe --disable=cjs-exclude && node scripts/check.mjs"
```

## Versions

Nuxt 4.6.1 · nitropack 2.13.4 · rollup 4.64.6 · @rollup/plugin-commonjs 29.0.3 · @rollup/plugin-node-resolve 16.0.3 · @vercel/nft 1.11.0 · @maizzle/framework 6.2.1 · vite 8.3.4 · rolldown 1.2.13 · pnpm 12.11.2. Measured on Windows 11 (Node 26.3) and in `node:24-slim` (Linux, glibc).

## Summary

| # | Problem | When | Workaround (`--disable` name) |
|---|---|---|---|
| 1 | The build parses the whole dependency graph of externals: out of memory | build | `nitro.commonJS.exclude` (`cjs-exclude`) |
| 2 | Native bindings picked at runtime are not traced | runtime | `traceInclude` (`trace-rolldown-binding`, `trace-lightningcss-binding`) |
| 3 | Packages loaded through runtime calls are not traced | runtime | `traceInclude` (`trace-vue-router`, `trace-compiler-sfc`) |
| 4 | `traceInclude` silently skips what it can't resolve, and resolves from the project root | build | absolute paths, resolved through the dependency chain |
| 5 | Stylesheets can't be traced at all | runtime | copied in the `compiled` hook (`copy-css`) |
| 6 | Only the build machine's native bindings can be traced | runtime | `pnpm install --libc` + `FORCE_MUSL` (Dockerfile) |
| 7 | `import.meta.url` is a placeholder while the server chunks load | runtime | don't derive paths from it at module level |

## 1. The build parses the whole dependency graph of externals

**What happens.** `@maizzle/framework` is external, so none of it is bundled. Yet without the workaround, Rollup parses Maizzle's entire dependency graph during the Nitro build and keeps it in memory. Nothing it parses that way ends up in the bundle: `--probe` reports these modules as unreachable from the bundle's entries.

Windows:

| | modules parsed | never bundled | peak heap | builds with heap capped at |
|---|---|---|---|---|
| all workarounds | 152 (0.9 MB) | 13 (0.1 MB) | 730 MB | 512 MB |
| `--disable=cjs-exclude,trace-compiler-sfc` | 617 (9.9 MB) | 478 (9.1 MB): `oxfmt` 6.4 MB, `nodemailer`, `@maizzle/framework`, PostCSS plugins… | 2,312 MB | |
| `--disable=cjs-exclude` | 623 (20.6 MB) | 484 (19.8 MB): adds `typescript` 9.3 MB, `@vue/compiler-sfc`, `@babel/parser` | 2,735 MB | runs out of memory at 1,536 and 2,048 MB |

Linux:

| | modules parsed | never bundled | peak heap | builds with heap capped at |
|---|---|---|---|---|
| all workarounds | 141 (0.9 MB) | 2 (0.1 MB) | 849 MB | 768 MB |
| `--disable=cjs-exclude,trace-compiler-sfc` | 141 (0.9 MB) | 2 (0.1 MB) | 694 MB | |
| `--disable=cjs-exclude` | 147 (11.5 MB) | 8 (10.7 MB): `typescript` 9.3 MB, `@vue/compiler-sfc`, `@babel/parser` | 1,898 MB | runs out of memory at 1,024 and 1,536 MB |

Module counts are the same on every run; peak heap (sampled every 50 ms) varies by up to about 25% between runs.

This app is small. The app it was extracted from ran out of memory on GitHub's `ubuntu-latest` runners, where Node's default heap is about 2 GB.

**Why.** To decide whether an import is external, Nitro's `node-externals` plugin resolves it through Rollup:

1. `node-externals` resolves the bare `@maizzle/framework` with `this.resolve()`.
2. `@rollup/plugin-node-resolve` turns it into an absolute path, then calls `this.resolve()` again with that absolute path. This is deliberate: its source says it doesn't skip itself "because another plugin might again use `this.resolve`".
3. The source changed (bare name → absolute path), so Rollup's skip list starts over, and `@rollup/plugin-commonjs`'s resolver handles the absolute id. When the id comes back not external, the commonjs plugin calls `this.load()` on it to see whether it is CommonJS, which parses it, and the same happens for each of its imports.
4. `node-externals` answers "not external" for an absolute id in two cases:
   - **On Windows, for every package entry.** It compares the package entry from its own resolver (`fileURLToPath`, so backslashes) with `normalize(originalId)` (forward slashes). They never match. This is why Maizzle's graph cascades on Windows and not on Linux.
   - **On any OS, for a file reached through an `exports` subpath.** For `vue/compiler-sfc/index.js`, `lookupNodeModuleSubpath()` returns `./compiler-sfc/index.js` (the file), not the export key `./compiler-sfc`, and `vue/compiler-sfc/index.js` doesn't resolve, since only `./compiler-sfc` is exported. `traceInclude` entries are resolved with `this.resolve()` in `buildEnd`, so the `vue/compiler-sfc` entry this app needs (§3) takes this path, and `compiler-sfc` pulls in `typescript`.

**Workaround.** `nitro.commonJS.exclude` names the two entries, so the commonjs plugin resolves them without loading them. They are external either way, so the output doesn't change. With and without it, every file under `.output/server/node_modules` is identical (SHA-1). The chunks differ only in the build id and timestamps, as they do between any two builds, and the generated `.output/server/package.json` lists `boolbase` as 1.0.0 instead of 2.0.0 (both versions are copied either way). The build is also faster.

## 2. Native bindings picked at runtime are not traced

Rolldown (Vite 8's bundler) and lightningcss (used by Tailwind and by Maizzle) load a per-platform native package whose name they build at runtime: `@rolldown/binding-<platform>-<arch>[-<libc>]`, `lightningcss-<platform>-<arch>[-<libc>]`. `@vercel/nft` can't follow a computed name, so `.output` gets the JavaScript of `rolldown` and `lightningcss` without their bindings. Packages whose loader names every platform package literally are traced fine: `@tailwindcss/oxide-*`, `@oxfmt/binding-*` and `@esbuild/*` all end up in `.output`.

| `--disable=` | `pnpm check` |
|---|---|
| `trace-rolldown-binding` | 500: `Cannot find native binding. npm has a bug related to optional dependencies…`, cause `Cannot find module '@rolldown/binding-wasm32-wasi'` |
| `trace-lightningcss-binding` | 500: `Cannot find module '../lightningcss.win32-x64-msvc.node'` (Linux: `linux-x64-gnu`) |

**Workaround.** Add the binding of the exact copy the runtime loads to `traceInclude`. Under pnpm that means walking the dependency chain (`@maizzle/framework` → `vite` → `rolldown` → binding), because two versions of `lightningcss` are installed here (Vite's 1.33.0, `@tailwindcss/node`'s 1.32.0) and only the binding of the copy Maizzle resolves is needed.

## 3. Packages loaded through runtime calls are not traced

| `--disable=` | loaded by | `pnpm check` |
|---|---|---|
| `trace-vue-router` | Maizzle, with `import.meta.resolve("vue-router/package.json")` to alias it for Vite | 500: `Cannot find package 'vue-router' imported from …/@maizzle/framework/dist/render/createRenderer.js` |
| `trace-compiler-sfc` | `@vitejs/plugin-vue`, through a `createRequire` it builds at runtime, inside a `try`/`catch` | 500: `Failed to resolve vue/compiler-sfc. @vitejs/plugin-vue requires vue (>=3.2.25) to be present in the dependency tree.` |

**Workaround.** `traceInclude` both. The `vue/compiler-sfc` entry is the one that triggers §1 on every OS.

## 4. `traceInclude` silently skips what it can't resolve

`buildEnd` resolves each entry with `this.resolve(entry)` and keeps it only `if (path?.id)`. An entry that doesn't resolve is dropped without a warning. Entries also resolve from the project root, where pnpm exposes only the app's own dependencies. So `traceInclude: ['@rolldown/binding-win32-x64-msvc']`, a transitive dependency, builds cleanly, and the server fails at runtime exactly as in §2.

**Workaround.** [`build/workarounds.ts`](build/workarounds.ts) resolves every entry to an absolute path itself, and fails the build if one can't be found. `require.resolve` is not enough for that: `@maizzle/framework`'s exports map has no `require` condition, and `lightningcss` doesn't export `./package.json`. So `packageDir()` walks `node_modules` directories the way Node does.

## 5. Stylesheets can't be traced at all

Tailwind reads stylesheets at render time with its own resolver: the email's `@import "@maizzle/tailwindcss"` (a package that is nothing but CSS), and from there `tailwindcss`'s `index.css`, `theme.css`, `preflight.css` and `utilities.css`. No JavaScript imports them, so nothing traces them. `tailwindcss` itself is traced for its JavaScript, without its stylesheets.

`traceInclude` can't help: a `.css` entry resolves to a virtual `\0raw:` id, which the tracer then opens as a path, and the build fails:

```
ERROR  The argument 'oldPath' must be a string, Uint8Array, or URL without null bytes. Received '…\nuxt-maizzle-x1\\\x00raw:…\node_modules\.pnpm\@maizzle+t…
    at CachedFileSystem._internalReadlink (…@vercel\nft\out\fs.js:61:32)
```

Without the stylesheets, Maizzle skips Tailwind, logs, and the endpoint answers 200 with an unstyled email:

| `--disable=` / change | `pnpm check` |
|---|---|
| `copy-css` | `ok: false`: `Can't resolve '@maizzle/tailwindcss' in '…/.output/server'` |
| copy `@maizzle/tailwindcss` only | `ok: false`: `Package path ./theme is exported from package …/.output/server/node_modules/tailwindcss, but no valid target file was found` |

**Workaround.** Copy them into `.output/server/node_modules` in Nitro's `compiled` hook.

## 6. Only the build machine's native bindings can be traced

pnpm installs only the bindings for the machine it runs on, and §2 resolves the binding for that machine. The app is built on Debian (glibc) and runs on Alpine (musl). An image built that way (`docker build --build-arg FORCE_MUSL=false .`) ships `@rolldown/binding-linux-x64-gnu` and `lightningcss-linux-x64-gnu`, and fails on Alpine with `Cannot find native binding`.

**Workaround.** The [`Dockerfile`](Dockerfile)'s build stage installs with `pnpm install --libc=glibc --libc=musl`, and `FORCE_MUSL=true` makes [`build/workarounds.ts`](build/workarounds.ts) trace the musl bindings. Without it, the libc is detected the way rolldown detects it ([`build/rolldown-binding.ts`](build/rolldown-binding.ts)).

## 7. `import.meta.url` is a placeholder while the server chunks load

A Nitro build replaces `import.meta.url` with `globalThis._importMeta_.url`. Each chunk sets that to `{ url: "file:///_entry.js" }` if it is unset. `.output/server/index.mjs` assigns the real value in its own body, which ESM runs only after the chunks it imports have been evaluated. So code evaluated with those chunks, such as a Nitro plugin's module scope, sees the placeholder. [`server/plugins/import-meta.ts`](server/plugins/import-meta.ts) records it, and `/api/render` reports it:

```json
"importMetaUrl": {
  "atLoad": "file:///_entry.js",
  "atRequest": "file:///app/.output/server/index.mjs"
}
```

A path computed from `import.meta.url` at module level (for example, walking up to find `node_modules`) silently resolves from `/`.

**Workaround.** [`server/utils/paths.ts`](server/utils/paths.ts) takes the server directory from the working directory instead: the app directory under `nuxt dev`, `.output/server` in a build.

## Not Nitro: Maizzle's `root`

Maizzle roots its Vite server at `root`, which defaults to the working directory, and since 6.2 also resolves a string template's CSS `@import`s from it. The server is started from the directory holding `.output`, so `render()` is given `root: SERVER_DIR`.

## Files

| | |
|---|---|
| [`server/api/render.get.ts`](server/api/render.get.ts) | renders an email with Maizzle, reports whether Tailwind ran |
| [`nuxt.config.ts`](nuxt.config.ts) | the Nitro configuration the workarounds plug into |
| [`build/workarounds.ts`](build/workarounds.ts) | `traceInclude`, `commonJS.exclude`, stylesheet copy |
| [`build/probe.ts`](build/probe.ts) | `--probe`: modules parsed, never bundled, peak heap |
| [`scripts/build.mjs`](scripts/build.mjs) | build with workarounds off, heap capped, probe on |
| [`scripts/check.mjs`](scripts/check.mjs) | run `.output` in isolation and render |
| [`Dockerfile`](Dockerfile) | Debian build stage, Alpine runtime |