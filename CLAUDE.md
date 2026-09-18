## 1. What we are building

**Rollcut** (rollcut.dev) is a GitHub Action that turns every release into a narrated demo video.

On `git tag v1.2.0`, the Action:
1. Launches headless Chromium (Playwright) against the deployed app or a preview URL.
2. Performs a walkthrough — from a YAML spec now, from an AI planner later.
3. Records at 1280×720 with a visible cursor and a soft zoom on clicks.
4. Generates a narration track from per-step notes (local TTS first; premium voices in the hosted tier).
5. Assembles `demo.mp4` and `demo.gif` with ffmpeg and burns subtitles.
6. Attaches both to the GitHub Release and, optionally, commits a README badge + GIF embed.

One-line pitch: **"Tag a release, get a trailer."**

Business model: open-core. The Action and local pipeline are MIT. The hosted tier (AI step planner, premium voices, hosting/embeds, auto-commit) is closed and paid at $19/month per repo. The licence decision is final on day 8; until then everything lives in this one repo.

## 2. Users and the one job

- **Buyer:** the developer or founder who owns the repo and the release — solo founders, devtool maintainers, 2–10 person SaaS teams.
- **Job:** never record a demo again; the demo is always in sync with the latest release.
- **Success for them:** one workflow file, one YAML, a fresh MP4 on every tag, zero editing.

## 3. Non-goals (do not build these)

- No interactive click-through demos (that is Supademo / Arcade).
- No video editor, timeline UI, or web dashboard in phase 1.
- No recording of a human screen session.
- No writing to the user's app or third-party tools; read-only against the target URL.
- No per-user analytics or tracking pixels in the output.
- No marketing site, logo, or brand work until the pipeline produces a good video.

## 4. Stack

- **Runtime:** Node 20, TypeScript (strict), ESM (`"type": "module"`), pnpm.
- **Browser:** `@playwright/test`, chromium only. Video via `recordVideo`.
- **Media:** `ffmpeg-static`. Every ffmpeg call goes through one helper in `src/media/ffmpeg.ts`.
- **Spec parsing:** `js-yaml` + `zod`. Never trust the YAML shape without zod.
- **TTS (phase 1):** `edge-tts` through a small Python shim, or `kokoro-js` if it installs cleanly. Pick one; hide it behind `src/tts/provider.ts` so premium providers plug in later.
- **Action packaging:** JS action bundled with `@vercel/ncc` into `dist/`; `action.yml` at root.
- **Tests:** `vitest` for pure logic (spec parsing, timing, subtitles). Playwright runs are integration tests, run only in CI or with `pnpm test:e2e`.
- **Lint/format:** `eslint` + `prettier`, default configs. Do not bikeshed them.

## 5. Repository layout

```
rollcut/
├── action.yml                 # GitHub Action metadata
├── CLAUDE.md                  # this file
├── README.md                  # usage first, install second, philosophy last
├── package.json
├── tsconfig.json
├── demos/
│   └── excalidraw.yaml        # canonical example spec; must always work
├── src/
│   ├── cli.ts                 # `rollcut record <spec>` local entry
│   ├── action.ts              # GitHub Action entry: reads inputs, calls pipeline
│   ├── spec/
│   │   ├── schema.ts          # zod schema for the YAML spec
│   │   └── load.ts
│   ├── record/
│   │   ├── driver.ts          # Playwright session, step execution loop
│   │   ├── cursor.ts          # injected cursor overlay + click zoom
│   │   └── steps.ts           # one function per step type
│   ├── tts/
│   │   ├── provider.ts        # interface: synthesize(text, voice) -> { wavPath, durationMs }
│   │   └── edge.ts            # phase-1 implementation
│   ├── media/
│   │   ├── ffmpeg.ts          # single wrapper around ffmpeg-static
│   │   ├── assemble.ts        # video + narration + subtitles -> mp4 / gif
│   │   └── subtitles.ts       # SRT/ASS from step notes + timings
│   └── publish/
│       ├── release.ts         # attach assets to the GitHub Release (octokit)
│       └── readme.ts          # optional badge / GIF embed commit
├── out/                       # gitignored build artifacts
└── test/
```

## 6. The spec format (v0)

```yaml
baseUrl: https://excalidraw.com
viewport: { width: 1280, height: 720 }
pauseMs: 700               # pause after every step
voice: en-US-AriaNeural    # optional, provider-specific
steps:
  - navigate: /
    note: "This is Excalidraw, a whiteboard that runs in the browser."
  - wait: 1500
  - click: "[title^='Rectangle']"
    note: "Pick the rectangle tool."
  - drag: { from: [420, 260], to: [760, 470] }
    note: "Draw a shape on the canvas."
  - click: "[title^='Text']"
  - clickAt: [590, 360]
  - type: "Hello from Rollcut"
    note: "Add a label."
  - press: Escape
```

Step types in v0: `navigate`, `click` (selector), `clickAt` (x, y), `drag`, `type`, `press`, `wait`, plus `scroll`, `hover`, and `waitFor` (selector) added in phase 4. Any step may carry a `note`; notes become narration and subtitles. Steps without notes are silent.

**Timing rule:** a step with a note must stay on screen at least as long as its narration audio. Measure TTS duration *before* recording and insert the matching pause so audio and video never drift. This is the single most important quality detail in the product.

## 7. Action interface (`action.yml`)

Inputs:
- `spec` (required): path to the YAML.
- `url` (optional): overrides `baseUrl`; used for preview deployments.
- `attach-to-release` (default `true`): upload mp4 + gif to the release that triggered the run.
- `update-readme` (default `false`): commit a badge / GIF embed to README.
- `voice` (optional).
- `token`: `${{ github.token }}`.

Outputs: `mp4`, `gif`, `duration-seconds`.

Minimal user workflow:

```yaml
on:
  release: { types: [published] }
jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rollcut/rollcut@v1
        with:
          spec: demos/app.yaml
          url: https://app.example.com
```

That is the entire install. If it ever needs more than this, something has gone wrong.

## 8. Build phases

Work strictly in order. Do not start a phase until the previous one produces a file you can watch.

**Phase 1 — Recorder (days 1–2)**
- [ ] `pnpm rollcut record demos/excalidraw.yaml` produces `out/demo.mp4` and `out/demo.gif`.
- [ ] zod schema with helpful errors for malformed specs.
- [ ] Injected cursor overlay: SVG cursor following `page.mouse`, click ripple, 1.15× zoom on click easing back over 600 ms.
- [ ] Deterministic timing: fixed pauses; no `networkidle` waits after the first navigate.

**Phase 2 — Narration (days 3–4)**
- [ ] `tts/provider.ts` interface + edge-tts implementation.
- [ ] Pre-measure narration durations; recorder waits accordingly.
- [ ] `media/assemble.ts` muxes audio; `subtitles.ts` burns subtitles (bottom, one line, safe margins).
- [ ] Output: narrated `demo.mp4`; silent `demo.gif` ≤ 8 MB.

**Phase 3 — Action (day 5)**
- [ ] `action.yml`, `src/action.ts`, ncc build to `dist/`, `v1` tag.
- [ ] Attach assets to the triggering Release via octokit.
- [ ] Runs green on this repo's own release.

**Phase 4 — Dogfood + polish (days 6–7)**
- [ ] README with a Rollcut-generated GIF at the top.
- [ ] Second demo spec against a different public app to shake out selector assumptions.
- [ ] `scroll`, `hover`, and `waitFor` steps.

**Phase 5 — AI planner (days 8–10)** — starts only after Phase 4 is done and reviewed.
- Input: `url` + README text → proposed spec YAML; human confirms. Lives in `src/plan/`; provider-agnostic LLM call behind an interface.

Phases 6–7 (hosted tier, billing, launch) are out of scope for this repo until told otherwise.

## 9. Conventions

- Small commits, imperative messages: `record: add click zoom`, `tts: measure duration before recording`.
- Every ffmpeg invocation logs its full argv at debug level; never hide it.
- No global state. Pipeline is `spec -> plan -> record -> narrate -> assemble -> publish`; each stage is a function that takes and returns file paths.
- Errors say what to do: "Selector `[title^='Rectangle']` not found on step 3 — open the site and check the element's title attribute."
- Keep `demos/excalidraw.yaml` working at all times; it is the smoke test.
- Ask before adding a dependency over 1 MB or any dependency with a native build step.
- When unsure whether something is in scope, re-read **Non-goals**.

## 10. Definition of done for phases 1–4

A stranger clones the repo, runs three commands from the README, and gets a narrated, subtitled, cursor-visible MP4 of Excalidraw in under 60 seconds. The same stranger adds the 6-line workflow to their own repo and gets a video on their next release without contacting us.

## 11. First command for this session

Read `demos/excalidraw.yaml` and `src/record.ts` if present, then implement Phase 1 exactly as specified. Report what you built, what you tested by actually running it, and anything that didn't work — in that order.
