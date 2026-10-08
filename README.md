<h1 align="center">niche-scanner</h1>

<p align="center">
  <strong>Search niches from product capabilities, enrich with Google data, write follow-up reports.</strong>
</p>

<p align="center">
  Source: <a href="https://github.com/polymech-info/niche-scanner">polymech-info/niche-scanner</a>
  · published as <code>@polymech/product-content-generator</code>
  (CLI: <code>phrases</code>)
</p>

GUI and CLI share the same store: `data/searches/<id>.json`.

## Quick start

```sh
cp .env-sample .env   # SERPAPI_KEY
npm i
npm run dev
```

Local GUI: API `3780`, UI `http://127.0.0.1:5175`. Routes: `/` opportunity, `/plan` product plan, `/capabilities` grounding.

```sh
npx tsx src/cli.ts run "markdown viewer"
npm run build
node dist/cli.js serve
```

`--data-dir` (or `PHRASES_DATA`) is the root for searches, results, logs, and `config.json`. Default: `./data`.

`discover-more` calls `tanit-cli llm agent each` (override with `PHRASES_LLM_BIN`).

## GUI

- **Opportunity** (`/`) — disposable topic explorer; promote phrases into a saved search.
- **Product plan** (`/plan`) — grouped job tree (features, workflows, commands). Select a feature for its detail and found searches / ranking / social. Check jobs, toggle Decide / Qualify / Enrich next to **Run**. Stage caches live under `data/results/product-plan/.cache`.
- **Capabilities** (`/capabilities`) — the same tree pattern. Enable or disable harvested evidence, add custom jobs, recapture Tanit, recompile feature pages. Overlay lives in `data/config.json` so refreshes keep your edits.

### Grounded opportunity dashboard

Enter one topic and a 2–8 call SERP budget. The server checks the topic against the Tanit capability snapshot before paid requests. Unsupported topics return the grounding decision with zero SerpAPI calls.

Supported topics collect autocomplete, related-search, and People Also Ask evidence, ranked by product fit. The run stays in memory for one hour: not written under `data/searches`, not in the sidebar, gone on restart. Promote selected phrases into a saved search to continue qualify / enrich / generate.

## Pipeline

```
seeds
  → search / expand     autocomplete, related searches, People Also Ask
  → classify            write / faq / cluster / skip  (+ global blacklist)
  → qualify             ranking links + featured snippets
  → enrich              site meta + Google AI overview
  → discover-more       LLM neighbor searches (optional)
  → generate            capability-grounded intelligence package + report
```

Qualify and enrich cost extra SerpAPI calls. Generate does not call SerpAPI. It may use one cached `tanit-cli llm agent each` pass; `--no-llm` stays deterministic.

## Product master plan

`runProductPlan` inverts the seed workflow: harvest jobs from the snapshot, search each with a bounded budget, dedupe globally, then opt into decide / qualify / enrich.

```sh
phrases product-plan \
  --jobs job:workflow:video-recorder,job:documentation:feature-markdown \
  --serp-budget 2

phrases product-plan --decide --qualify
phrases product-plan --no-qualify --enrich
phrases product-plan --render-only
phrases product-plan --clear
phrases product-plan --remove-jobs job:documentation:feature-markdown
```

`--no-cache` disables `<out>/.cache`. `--force` / `--force-discover` / `--force-decide` / `--force-qualify` / `--force-enrich` invalidate stages.

## Product grounding

```sh
npm run capabilities:refresh    # capture + compile
npm run capabilities:capture
npm run capabilities:compile
```

Capture pulls Tanit CLI / ribbon custom commands / XBlox / UI surfaces. Compile folds in `releases/web-docs/features/feature-*.md` and writes `data/product-capabilities.json`. Overlay enable/disable and custom caps stay in `data/config.json`.

Refresh whenever CLI registrations, XBlox flows, UI surfaces, or published feature pages change.

## CLI examples

```sh
npx tsx src/cli.ts run "markdown viewer"
npx tsx src/cli.ts search "markdown viewer" --name "Markdown viewer"
npx tsx src/cli.ts qualify markdown-viewer-5471b6 --limit 8
npx tsx src/cli.ts enrich markdown-viewer-5471b6 --enrichers meta,ai
npx tsx src/cli.ts generate markdown-viewer-5471b6 --no-llm
npx tsx src/cli.ts serve --port 3780
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--engines` | `ac,rs,rq` | autocomplete, related searches, People Also Ask |
| `--paa-depth` | `0` | extra PAA hops (0–4) |
| `--alphabet` | off | 26 extra autocomplete calls per seed |
| `--questions` | off | prefix seeds with how/what/why/… |
| `--gl` `--hl` `--domain` | `us` `en` `google.com` | locale |

## Data

| Path | What |
| --- | --- |
| `<data-dir>/searches/<id>.json` | phrases, SERP, scores, neighbors |
| `<data-dir>/results/<id>/` | generate output |
| `<data-dir>/config.json` | blacklist, product limits, capability overlay |
| `data/product-capabilities.json` | Tanit snapshot (not scoped by `--data-dir`) |
| `<data-dir>/logs/` | server + shell logs |
| `.env` | `SERPAPI_KEY` (cwd, then package) — never commit |

## Deployment

Source of truth: [github.com/polymech-info/niche-scanner](https://github.com/polymech-info/niche-scanner.git). Hosted UI (after web deploy): `https://polymech.info/apps/niche-scanner/`. The static UI still needs a running `phrases serve` API for live search.

### GitHub (package git)

This folder is published as its own git repo, same pattern as OpenDesign / runny. From the pixlwiz root:

```sh
# first time only, in infrastructure/lead-generator:
git init
git remote add origin https://github.com/polymech-info/niche-scanner.git

# later, from pixlwiz root (build + test + commit + push):
npm run publish:gh:niche-scanner
npm run publish:gh:niche-scanner -- --dry-run
npm run publish:gh:niche-scanner -- -m "feat: product plan tree"
```

Or from this folder: `npm run deploy:gh`.

`.env`, `node_modules`, `dist`, and `data/searches|results|logs` stay out of git.

### Web (polymech.info)

Same flow as OpenDesign’s `deploy-web.mjs`: production client bundle, tar, `scp` to host `polymech`, extract under the public apps tree.

Needs SSH alias `polymech` with batch-mode keys.

```sh
npm run build:web
npm run deploy:web
```

`deploy:web` builds then copies `dist/client-web` to `/var/www/vhosts/polymech.info/httpdocs/apps/niche-scanner` and sets owner/mode. It does not upload `.env` or search data.
