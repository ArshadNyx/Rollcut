# Rollcut

**Tag a release, get a trailer.**

Rollcut is a GitHub Action that turns every release into a narrated demo video. Tag `v1.2.0`, and it drives your app in a headless browser, narrates the walkthrough, and attaches `demo.mp4` and `demo.gif` to the GitHub Release.

<!-- rollcut:start -->

![Demo](https://img.shields.io/badge/demo-18.6s-8b5cf6)

[![Demo](https://github.com/ArshadNyx/Rollcut/releases/download/v1.0.0/demo.gif)](https://github.com/ArshadNyx/Rollcut/releases/download/v1.0.0/demo.mp4)

_Recorded automatically by [Rollcut](https://rollcut.dev) for `v1.0.0`._

<!-- rollcut:end -->

## Use it in your repo

```yaml
on:
  release: { types: [published] }
jobs:
  demo:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: ArshadNyx/Rollcut@v1
        with:
          spec: demos/app.yaml
          url: https://app.example.com
```

That is the whole install.

## Try it locally

```bash
pnpm install
pnpm exec playwright install chromium
pnpm rollcut record demos/excalidraw.yaml
```

You get `out/demo.mp4`, `out/demo.gif` and `out/demo.srt`. The record step takes under a minute; the first `pnpm install` is considerably longer, because Chromium and the local TTS model are large one-time downloads.

## The spec

```yaml
baseUrl: https://excalidraw.com
viewport: { width: 1280, height: 720 }
pauseMs: 700 # pause after every step
steps:
  - navigate: /
    note: 'This is Excalidraw, a whiteboard that runs in the browser.'
  - click: "[title^='Rectangle']"
    note: 'Pick the rectangle tool.'
  - drag: { from: [420, 260], to: [760, 470] }
  - type: 'Hello from Rollcut'
  - press: Escape
```

Any step may carry a `note`. Notes become narration and subtitles; steps without one are silent.

| Step       | Value                          | Notes                                                 |
| ---------- | ------------------------------ | ----------------------------------------------------- |
| `navigate` | path or URL                    | Resolved against `baseUrl`.                           |
| `click`    | selector                       | Scrolls into view, then clicks with a visible cursor. |
| `clickAt`  | `[x, y]`                       | Viewport coordinates.                                 |
| `drag`     | `{ from: [x, y], to: [x, y] }` |                                                       |
| `type`     | text                           | Typed with a human delay.                             |
| `press`    | key                            | e.g. `Escape`, `Enter`.                               |
| `wait`     | milliseconds                   |                                                       |
| `scroll`   | pixels or selector             | Smooth; a selector is scrolled to centre.             |
| `hover`    | selector                       | Moves the cursor without clicking.                    |
| `waitFor`  | selector                       | Waits up to 15s for the element to be visible.        |

**Timing:** narration is synthesized _before_ recording, and each step is held at least as long as its line takes to speak, so audio and video never drift.

## Action inputs

| Input               | Default               | Description                                                                                                                   |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `spec`              | _required_            | Path to the YAML spec.                                                                                                        |
| `url`               | —                     | Overrides `baseUrl`, for preview deployments.                                                                                 |
| `attach-to-release` | `true`                | Upload the assets to the triggering release.                                                                                  |
| `update-readme`     | `false`               | Commit a badge + GIF embed to the README. Needs `attach-to-release` and `contents: write`. **Public repos only** — see below. |
| `voice`             | —                     | Provider-specific voice name.                                                                                                 |
| `tts`               | `kokoro`              | `kokoro` (local) or `edge`.                                                                                                   |
| `narration`         | `true`                | Set `false` for a silent video.                                                                                               |
| `subtitles`         | `true`                | Burn subtitles into the MP4.                                                                                                  |
| `token`             | `${{ github.token }}` | Used to upload release assets.                                                                                                |

Outputs: `mp4`, `gif`, `duration-seconds`, `asset-urls`.

With `update-readme: true`, Rollcut maintains a block in your README delimited
by `rollcut:start` and `rollcut:end` HTML comments. If those markers are absent
it inserts the block under your first heading; on later releases it replaces the
block in place rather than stacking duplicates. Markers are only recognised when
they sit alone on a line, so prose that mentions them (like this paragraph) is
left alone.

**This only works on public repositories.** The embed points at release assets,
and GitHub renders README images through a proxy that is not authenticated
against your repository — on a private repo the GIF resolves to a broken image.
Rollcut warns and carries on rather than failing the release. If your repo is
private, commit the GIF into the repository and embed that path instead.

## Narration

Two providers sit behind one interface (`src/tts/provider.ts`):

- **`kokoro`** (default) — runs locally, Apache-2.0 library and weights, so you may publish the generated speech. Costs a one-time ~170 MB model download.

  `kokoro-js` is an **optional dependency**: it installs by default, so narration works out of the box. Skip it with `pnpm install --no-optional` to save roughly 350 MB, and the install degrades gracefully on platforms where onnxruntime has no prebuilt binary.

- **`edge`** — Microsoft Edge voices via `edge-tts`. Needs `pip install edge-tts` and network access. It talks to an undocumented Microsoft endpoint and the generated audio carries no redistribution grant, so it is opt-in and not recommended for published videos.

Use `--no-narration` (or `narration: false`) to skip TTS entirely.

## Keeping a spec working

Specs rot. You rename a button, and a release video breaks weeks later without
anyone noticing.

```bash
pnpm rollcut repair demos/app.yaml --check    # report only, non-zero if broken
pnpm rollcut repair demos/app.yaml            # mend it in place
```

Repair replays the spec against the live site. When a step fails, it reads what
is on the page _at that point in the run_ — which no fresh visit could
reproduce — ranks what most likely replaced the missing element, and **tries
the replacement before writing it down**. A repair is therefore something that
demonstrably worked, not a suggestion.

Matching is deterministic by default, so the reason is always explainable: a
rename usually keeps most of the wording. That is blind to a rename that keeps
the _meaning_ and changes the words — "Verify & continue" to "Confirm school"
shares no words at all — so `--smart` consults a model, but only for the steps
word overlap could not place:

```bash
pnpm rollcut repair demos/app.yaml --smart
```

Either way, if nothing on the page plausibly matches, the step is reported
unrepaired. Offering a Delete button in place of a missing Save one would be
worse than failing, and a replacement is always tried on the page before it is
written down.

### In CI

The Action runs the same check, so your demos are watched without anyone
remembering to look:

```yaml
name: Drift
on:
  schedule: [{ cron: '23 7 * * *' }]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ArshadNyx/Rollcut@v1
        with:
          mode: check
          spec: demos/app.yaml
```

It writes a job summary naming the selector that moved and the command that
fixes it, and fails the job so you notice. Set `fail-on-drift: false` to report
without failing, or read the `drifted` output to decide for yourself.

Recording needs a release; checking does not, which is the point — you find out
the day your app changes rather than the day you cut a release.

## Capturing a spec from a real run

The surest way to get a spec is to perform the demo once:

```bash
pnpm rollcut capture https://app.example.com --readme README.md --out demos/app.yaml
```

A browser opens with a recording bar. Click through your product — sign in,
open a modal, fill a form — then press **Finish**. Rollcut writes the spec from
what you actually did, and a model writes the narration for it.

This is the answer for anything a crawler cannot reach: pages behind a login, a
multi-step wizard, or a form that needs a real value. A planner can only guess
that a school code looks like its placeholder; capture saw you type the real
one.

The split is deliberate. Capture gets the mechanics exactly right because it
watched them happen — selectors, order, the values you entered, and the pauses
you took. The model only supplies words for steps it is told occurred; it never
invents one. Use `--no-notes` to skip narration entirely.

## Planning a spec (experimental)

Writing a spec by hand means hunting for selectors. `rollcut plan` proposes one
for you from a live page:

```bash
pnpm rollcut plan https://excalidraw.com --readme README.md --out demos/app.yaml
```

It opens the page and a few pages it links to, collects the targets that have
unique selectors on each — preferring `data-testid`, `id`, `aria-label`,
`title`, `name` or `href`, and falling back to matching on visible text for
component libraries that emit nothing but class names — and asks a model for a walkthrough that can
move between them. Use `--pages` to change how many are visited (default 4). **It only proposes** — nothing is recorded
and nothing is committed. Read the spec, edit it, then run `rollcut record` on
it yourself.

Four things keep the output honest, all enforced in code rather than asked for
in the prompt — models tested ignored every one of these when it was only a
written instruction:

- The model may only use selectors that were actually found on the page. Any it
  invents are dropped and reported rather than written into the spec.
- Every step is checked against **the page it actually runs on**. Following a
  link moves that cursor, so a selector from the previous page is dropped
  rather than shipped. Navigate somewhere that was not observed and the
  selector steps after it are dropped too, since nothing there was verified.
- Coordinates (`clickAt`, `drag`) are offered only when the page has a real
  canvas, and are rejected unless they land inside it. Without this, canvas
  apps get a demo that selects a tool and never draws anything.
- An undo immediately followed by a redo is removed: it looks like activity and
  changes nothing.
- The result is validated against the same zod schema a hand-written spec goes
  through. The planner gets no special treatment.
- **The proposed spec is then replayed in a real browser** and any step that
  fails is dropped. Static checks can only prove a selector was on the page
  when we looked; whether the step actually works — the element is reachable,
  nothing covers it, the app is in the right state — is only answerable by
  doing it. Steps replay through the same executor the recorder uses, so a
  pass here means the same thing it will during recording. Skip it with
  `--no-verify` if you would rather read the raw proposal.

Even so, **read what it proposes**. The checks guarantee a runnable spec, not
an interesting one — whether the walkthrough is worth watching is still a
judgement call, and that is why a human confirms.

### Planner backends

Choose with `--llm` (or `ROLLCUT_LLM`); `ROLLCUT_PLAN_MODEL` overrides the model
for whichever one you pick.

| `--llm`               | Credentials                              | Default model            | JSON mode |
| --------------------- | ---------------------------------------- | ------------------------ | --------- |
| `anthropic` (default) | `ANTHROPIC_API_KEY`, or `ant auth login` | `claude-opus-5`          | schema    |
| `openai`              | `OPENAI_API_KEY`                         | `gpt-5`                  | schema    |
| `grok`                | `XAI_API_KEY`                            | `grok-4.6`               | schema    |
| `groq`                | `GROQ_API_KEY`                           | `openai/gpt-oss-120b`    | schema    |
| `kimi`                | `MOONSHOT_API_KEY`                       | `kimi-k2.6`              | schema    |
| `qwen`                | `DASHSCOPE_API_KEY`                      | `qwen-plus`              | object    |
| `openrouter`          | `OPENROUTER_API_KEY`                     | `openai/gpt-oss-120b`    | schema    |
| `custom`              | `ROLLCUT_LLM_KEY` + `ROLLCUT_LLM_URL`    | set `ROLLCUT_PLAN_MODEL` | object    |

Only `anthropic` needs a dependency (the optional `@anthropic-ai/sdk`); every
other backend speaks the OpenAI chat-completions dialect over plain HTTPS.

**JSON mode** is how the plan is constrained. `schema` means the provider
constrains decoding to the spec schema. `object` means it only promises valid
JSON, so the schema goes in the prompt instead — the result is validated the
same way either way, so a loose plan is rejected rather than recorded. Only
providers that document schema support claim it.

> **`grok` and `groq` are different services.** Grok is xAI's model
> (`XAI_API_KEY`, api.x.ai); Groq is a fast-inference provider
> (`GROQ_API_KEY`, api.groq.com). Each backend reports only its own credential
> in errors so a mix-up is obvious.

Endpoints are overridable for region-specific or self-hosted deployments:
`ROLLCUT_QWEN_URL` (Model Studio is region-specific), `ROLLCUT_GROQ_URL`,
`ROLLCUT_GROK_URL`. Anything else OpenAI-compatible works via `--llm custom`:

```bash
export ROLLCUT_LLM_URL=https://my-host/v1/chat/completions
export ROLLCUT_LLM_KEY=...
pnpm rollcut plan https://example.com --llm custom
```

Default models are a starting point, not a promise — if a provider rejects one,
the error says to set `ROLLCUT_PLAN_MODEL`.

```bash
export GROQ_API_KEY=gsk-...
pnpm rollcut plan https://excalidraw.com --llm groq --out demos/app.yaml
```

Only some models support constrained decoding. The defaults above do; if you
point `ROLLCUT_PLAN_MODEL` at one that does not, the provider may ignore
`strict` and return loosely-shaped JSON — which the schema validation
downstream will reject rather than pass on.

Adding another OpenAI-compatible backend is one row in `PRESETS`
(`src/plan/presets.ts`). Anything else means one file implementing
`PlanProvider`.

## CLI

```
rollcut record <spec.yaml> [options]
rollcut plan <url> [options]

  --url <baseUrl>   Override the spec's baseUrl.
  --readme <path>   (plan) Give the planner your README for context.
  --out <dir>       Output directory (default: out).
  --voice <name>    Provider-specific voice name.
  --tts <name>      kokoro | edge (default: kokoro).
  --no-narration    Record silently.
  --no-subtitles    Narrate without burning subtitles.
```

Set `ROLLCUT_DEBUG=1` to see every ffmpeg invocation in full.

## Why the zoom is applied afterwards

The soft zoom on each click is applied to the finished recording with ffmpeg,
not to the live page. A CSS transform on `<html>` makes `position: fixed`
resolve against the transformed element, so a sticky header detaches from the
viewport and — on a scrolled page — disappears entirely for the length of the
zoom. Cropping the capture afterwards cannot disturb a layout that has already
been recorded, and it is what screen recorders do anyway.

## Assumptions, and where they are not made

Rollcut has to work on sites it has never seen, so the things that vary between
sites are either measured or configurable rather than fixed:

- **How long a page takes to render** is measured, not assumed. The observer
  polls until the page stops producing new targets, so a static page is not
  delayed and a heavy single-page app is not cut short.
- **A product can span subdomains.** A marketing site on `www` linking to an
  app on a subdomain is one product, and the crawler follows it. Pages are
  keyed by origin _and_ path, because `/` on the marketing site is not `/` on
  the app, and a step referring to another subdomain uses an absolute URL.
- **A control repeated in a header, hero and footer** — the usual shape for the
  most important link on a page — is still usable: a step acts on the first
  match, so that is what is recorded.
- **Sign-in pages are not skipped.** For many products the sign-in flow is the
  demo. Only paths that end a session or cost money are avoided by default, and
  that list is overridable.
- **Match confidence, page budget, targets per page and candidate count** are
  all options with defaults rather than constants.

What _is_ fixed is the output format — zoom timing, subtitle metrics, audio
rate — where consistency is the point.

## How this repo tests itself

- **CI** (`ci.yml`) on every push and pull request: lint, format, types, unit
  tests, build, a guard against a stale `dist/`, and Playwright integration
  tests against a local fixture.
- **Canary** (`canary.yml`) nightly: records `demos/excalidraw.yaml` and
  `demos/vitest.yaml` against the real sites. Those specs depend on third-party
  markup, so they are checked on a schedule rather than in CI — a redesign
  elsewhere is not a regression in your pull request, and must not block it.
- **Demo** (`demo.yml`) on every release: records this repo's own demo, attaches
  it, and updates the block at the top of this README.

## Caching in CI

The Action restores the pnpm store, Chromium and the TTS weights from
`actions/cache`. GitHub scopes caches per ref and only the default branch's
caches are readable from every other ref, so a release running on a tag can
never reuse a cache written by another tag. This repository's CI workflow
populates that cache on `main`; if you fork Rollcut, keep a workflow on your
default branch doing the same or every release will start cold.

## Philosophy

Demo videos rot. They are recorded once, by hand, and are wrong by the next release. Rollcut makes the demo a build artifact: it is regenerated from a spec on every tag, so it is either current or it fails loudly.

It deliberately does not do interactive click-through demos, video editing, or screen recording of a human session. It reads your app and produces a file.

## Licence

MIT.
