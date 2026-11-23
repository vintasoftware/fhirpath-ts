# fhirpath-ts playground

The playground is a client-only demonstration of the engine, TypeScript
inference, and the analyzer for FHIRPath's
[type safety and strict evaluation rules](https://hl7.org/fhirpath/STU3/en/index.html#type-safety-and-strict-evaluation).
It runs entirely in the browser.
No FHIR data is sent to a server.
Type inference computes safe TypeScript types; the analyzer reports expression errors.
Literal host values infer automatically; `envTypes` and `varTypes` handle ambiguous values.

Try the [live playground](https://vintasoftware.github.io/fhirpath-ts/).

Use it to explore:

- evaluation against editable R4 resources;
- input and result types inferred for literal paths, operators, functions, and variables;
- parser, type, cardinality, and unknown-element diagnostics;
- `test`, `filter`, `checkConstraints`, and `project` behavior;
- Bundle navigation and reference resolution;
- exact decimal, date, time, Quantity, and UCUM behavior;
- fixed clocks and `trace()` output;
- DTO-style application projections shown in the samples.

The repository README keeps its recipes short and points here for interactive
examples.

## Package imports

The demo imports the library from `../src` through Vite aliases. Its application
code uses the same package entry points as a consumer:

```ts
import { compile } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'
import { analyzeExpression } from 'fhirpath-ts/analyzer'

const names = compile('Patient.name.given')
```

## Develop

```bash
cd demo
npm install
npm run dev
```

The development server starts at `http://localhost:5173` by default.

## Build

```bash
npm run build
npm run preview
```

The static output is written to `demo/dist`.

## Browser check before a release

`npm test` compiles the samples and `npm run typecheck` checks the demo code. No
test drives the page itself. Before a release, build the demo and check it in a
headless browser, for example with puppeteer-core and a local Chrome:

```bash
npm run build
npm run preview   # serves http://localhost:4173
```

Check the explorer, then open every playground tab. No tab should show an error,
and each runnable sample should run. After the Pages deployment, repeat the check
against the live site. This catches problems that unit tests cannot reach, such
as the worker start-up order described in
[AGENTS.md](../AGENTS.md#monaco-worker-integration).

A script needs these details:

- The playground loads Monaco only when `[data-playground]` comes near the
  viewport (an `IntersectionObserver` in `src/main.ts`). Call `scrollIntoView()`
  on it, then wait for `[data-pg-tabs] button`.
- A scripted `click()` scrolls the page, so it can mount the playground while the
  explorer is still being checked.
- The output panel under the editor renders again each time results arrive.
  TypeScript and analyzer markers come from separate asynchronous passes, so the
  panel can show `.pg-clean` before either has reported. Wait for both before
  judging a tab. Each output or problem line is a `.pg-row`; run output adds
  `pg-out`, and problems add `pg-problem-error` or `pg-problem-warning`.
- `[data-pg-run]` is hidden for samples that cannot run.

## Monaco declarations

The editor checks sample code against declarations generated from the library's
public API. `scripts/generate-dts.mjs` writes the declaration bundle to
`src/monaco/*.d.ts` before development and production builds.

Run the declaration step by itself after changing the public API:

```bash
npm run generate:dts
```

The generated files are ignored by Git.

## Deployment

The output is a static site. It does not require a Worker or an application
server. Vite uses relative asset paths, so the same build works at the
`/fhirpath-ts/` GitHub project path and at other deployment paths.

### GitHub Pages

The [Pages workflow](../.github/workflows/pages.yml) builds `demo/`, uploads
`demo/dist`, and deploys it after each push to `main`. It can also be run
manually from the Actions tab.

Before the first deployment, select **GitHub Actions** as the source under
**Settings → Pages → Build and deployment**. No branch containing generated
assets is required.

### Cloudflare Pages

Cloudflare Pages can use:

- Build command: `cd demo && npm install && npm run build`
- Build output directory: `demo/dist`

The existing CLI deployment command targets Cloudflare Pages:

```bash
npm run build
npm run deploy
```
