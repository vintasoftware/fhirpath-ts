# Releasing

How a new version of `fhirpath-ts` gets to npm, and what the setup behind it is.

After the one-time first-publish bootstrap, publishing is done by CI from a tag.
There is no npm token in this repository's secrets, and a normal `npm publish`
from a laptop is expected to fail — see
[Why publishing only works from CI](#why-publishing-only-works-from-ci).

## Cutting a release

1. **Pick the version.** The package follows semver. Pre-1.0, a breaking change
   bumps the minor (`0.1.0` → `0.2.0`) and everything else bumps the patch. The
   repo's commits are already Conventional Commits, so `feat!:` / `BREAKING
   CHANGE:` since the last tag is the signal that a minor is due.

2. **Run the gates locally.** Faster to find out here than in the release run:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm check:fhirpath
   pnpm check:type-perf
   pnpm build
   pnpm check:package
   ```

3. **Update `CHANGELOG.md`.** Move what is under `Unreleased` into a new section
   headed by the version and today's date.

4. **Bump the version and tag it**, on a branch, as one commit:

   ```sh
   git switch -c release/v0.2.0
   pnpm version 0.2.0 --no-git-tag-version   # edits package.json only
   git commit -am 'chore(release): v0.2.0'
   ```

   Open a PR, get it reviewed, merge it. Then tag the merge commit on `main`:

   ```sh
   git switch main && git pull
   git tag -a v0.2.0 -m 'v0.2.0'
   git push origin v0.2.0
   ```

   The tag must be `v` + the exact `version` in `package.json`. The release
   workflow compares the two and stops if they disagree.

5. **Watch the run.** `.github/workflows/release.yml` calls the same full CI
   workflow on the tagged commit, then checks the version, builds, checks the
   package, prints the tarball's file list, and publishes. If the `npm-publish`
   environment has required reviewers configured, it waits for an approval
   between the two jobs.

6. **Check what landed:** `npm view fhirpath-ts version`.

### If a release goes wrong

Do not unpublish and re-push the same version — npm will not accept a
republished version number, and anything that already installed it keeps the bad
copy. Publish a patch instead. `npm deprecate fhirpath-ts@0.2.0 "<reason>"`
marks the bad version so installs warn.

## One-time setup on npmjs.com

Only needed once, or if the workflow file is renamed.

1. If the package name has never been published, use a fresh disposable clone to
   publish a prerelease with a granular access token. npm cannot attach a trusted
   publisher until the package exists. The bootstrap uses a version and dist-tag
   that the real release will never reuse:

   ```sh
   pnpm install --frozen-lockfile
   node node_modules/npm/bin/npm-cli.js pkg set version=0.0.0-bootstrap.0
   pnpm build
   bootstrap_dir="$(mktemp -d)"
   pnpm check:package -- --output "$bootstrap_dir/fhirpath-ts.tgz"
   node node_modules/npm/bin/npm-cli.js publish "$bootstrap_dir/fhirpath-ts.tgz" --access public --tag bootstrap --ignore-scripts
   ```

   This publishes the exact tarball the package check installed and exercised.
   Do not commit or tag the temporary version change; discard the clone after the
   remaining setup. In particular, do not publish the real `0.1.0` here.

2. On npmjs.com, the package's **Settings → Trusted publisher** needs:
   - Publisher: **GitHub Actions**
   - Organization / repository: `vintasoftware` / `fhirpath-ts`
   - Workflow filename: `release.yml`
   - Environment: `npm-publish`
   - Allowed action: **npm publish**

   The environment field has to match the `environment:` in the publish job. The
   OIDC token's subject includes the environment name, so a mismatch fails the
   publish with an authentication error rather than a helpful one.

3. In this repository's **Settings → Environments**, create `npm-publish`. Adding
   required reviewers there is what turns a pushed tag into something a second
   person approves.

4. Delete the bootstrap token and discard the bootstrap clone. Future publishes
   authenticate only through the workflow's short-lived OIDC token. The first
   real release is still `v0.1.0`, cut through the normal process above; its
   workflow publishes `0.1.0` under npm's default `latest` dist-tag.

## What gets published

`files` in `package.json` is an allowlist — `dist`, `src` minus tests, and
`THIRD-PARTY-NOTICES.md`. npm adds `package.json`, `README.md` and `LICENSE` on
its own. Everything else in the repo (`demo`, `dogfood`, `benchmarks`,
`test-data`, `scripts`, `ai-plans`, `.github`, coverage output) stays out.

To see the exact list without publishing:

```sh
pnpm build && npm pack --dry-run --ignore-scripts
```

`src` is in the tarball for the sourcemaps only: `dist/*.js.map` and
`dist/*.d.ts.map` point at `../src/*.ts`, so shipping it makes stack traces land
on real source and go-to-definition walk into typed source instead of stopping at
a `.d.ts`. It is not reachable as an import — `exports` lists five entry points
and nothing else, so `fhirpath-ts/src/anything` is blocked.

### Checking the tarball for real

`pnpm check:package` packs once, then sends that exact tarball through two static
validators:

- **publint** — the manifest against the tarball: entry points that point at
  files that are not there, wrong `types` order, missing `files`.
- **attw** (`are-the-types-wrong`) — resolves every entry point's types the way a
  consumer's TypeScript will. It runs under `--profile esm-only`, which reports
  but does not fail on the two conditions inherent to an ESM-only package:
  `require()` resolving to ESM, and node10 resolution not understanding
  `exports`. Both are still printed, so a *new* problem in those columns is
  visible.

The same command then installs the tarball into a temporary consumer, links the
lockfile-installed optional peers, imports every public entry point, type-checks
them without `skipLibCheck`, and runs the installed `fhirpath-check` binary
through both source-only and loaded-DTO checks. This covers emitted imports,
`bin`, `dist/cli/ts-loader.mjs`, and peer resolution rather than testing the
source tree twice.

Pass `-- --output <path>` to preserve the validated tarball. The release workflow
uses that path for both its dry run and `npm publish`, so it publishes the exact
bytes the validators and temporary consumer exercised.

## How the build works

`pnpm build` is `tsc -p tsconfig.build.json` after deleting `dist`. No bundler:
one output file per input file, so the shape of `dist` matches `src`, and
`dist/cli/ts-loader.mjs` stays a real file that `register()` can be handed a URL
to.

Two things in `tsconfig.build.json` are load-bearing:

- **`rewriteRelativeImportExtensions`** — the source imports siblings as
  `'./foo.ts'`. This rewrites them to `'./foo.js'` in the emitted JavaScript and
  declarations. Without it, `tsc` cannot emit at all with
  `allowImportingTsExtensions`.
- **`module`/`moduleResolution: nodenext`** — the root `tsconfig.json` uses
  bundler resolution, which is right for the source and for Vitest but does not
  say anything about whether Node can read the result. Building under `nodenext`
  makes the build a check on the published shape.

The package is **ESM-only**. `engines.node` is `>=22`, so `require()` of it works
on Node 22.12 and later through `require(esm)`; older 22.x and any CJS bundler
that does not support it need a dynamic `import()`.

### The `fhirpath-ts-source` condition

`dogfood/` and the CLI's test fixtures import the library **by package name**, the
way a consumer does. Node and TypeScript both resolve that through this
package.json's own `exports` — a package can self-reference its own name — and
those entries name `dist`. So the repo would read its own built output, and a
DTO registering an engine in that copy of the library is invisible to a checker
running from `src`: the symptom is `fhirpath-check` reporting a DTO module that
"export[s] no DTO class", with an exit code of 0.

The first condition in every `exports` entry points at `src` to fix that, and
three places opt into it:

| Where | How |
| --- | --- |
| `tsconfig.json` | `customConditions: ["fhirpath-ts-source"]` |
| `check:fhirpath` script | `node --conditions=fhirpath-ts-source` |
| `fhirpath-check.test.ts`, `patient-view-mappers.test.ts` | `--conditions=` on the spawned CLI |

The name is deliberately unlovely. Condition names are only active if a tool asks
for them, and no tool asks for this one by default — unlike `development`, which
Vite enables in dev and which would silently hand consumers raw `.ts` source. If a
new place starts importing the library by name and sees a second copy of the
engine, this condition is the thing it is missing.

**Vitest is the exception**: it hands bare specifiers to Node to resolve, and Node
knows nothing of Vite's conditions, so `vitest.config.ts` carries `resolve.alias`
entries instead. A condition there looks like it works as long as a stale `dist`
happens to exist — the tests read it, and an `analyzeEngineDtos(engine)` sweep
against a registry that never saw that engine reports no problems for the wrong
reason.

The check that actually settles either mechanism is to delete `dist` and run the
gates: `pnpm run clean && pnpm typecheck && pnpm coverage && pnpm check:fhirpath`.
Anything reaching for the built output fails outright instead of passing quietly,
which is also the order CI runs them in — `build` comes after `coverage`.

`pnpm build` does not use the condition: nothing under `src` imports the package
by name, and the build compiles `src` directly.

`sideEffects` is an allowlist, not `false`. `src/functions/*` register themselves
into the function registry at module scope and are imported for that effect
alone (`src/functions/install.ts`), so a bundler told the package were
side-effect-free would drop every FHIRPath function. The patterns are directory
globs, so adding a module under `src/functions/` needs no change here.

## Dependencies

The package has **no runtime dependencies**. It has two optional peers:

- **`typescript`** (`>=5.0.0 <7.0.0`) — needed only by `fhirpath-ts/sites` and
  the `fhirpath-check` CLI, which read `.ts` source. The upper bound is real: the
  native port's `typescript` entry point exports `version` and little else, so
  `ts.ScriptTarget` and `ts.transpileModule` are absent and the CLI throws at
  startup. Raise the bound only with the CLI actually exercised against that
  version from an installed tarball.
- **`eslint`** (`>=9.0.0`) — needed only by `fhirpath-ts/eslint`, whose
  declarations import `Rule` from it.

Both are optional, so consumers who use neither entry point install nothing
extra. When a new external import shows up in shipped source, it belongs in
`dependencies` or `peerDependencies` — a `devDependency` will resolve locally and
in CI and then fail for consumers. `pnpm check:package` catches the cases that
reach a published `.d.ts`.

## Why publishing only works from CI

The trusted publisher accepts the short-lived OIDC token minted for the
configured workflow, repository, and environment. After the bootstrap token is
deleted, a local `npm publish` has no publish credential and fails. There is no
long-lived npm token to leak, rotate, or scope.

npm does not generate provenance attestations for private source repositories.
If this repository becomes public, trusted publishing will add provenance
automatically; the release workflow does not need a second authentication path
or a `publishConfig.provenance` flag.
