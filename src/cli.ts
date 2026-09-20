#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_PROVIDER, PROVIDERS, runPipeline } from './pipeline.js';
import { plan } from './plan/planner.js';
import { DEFAULT_PLAN_PROVIDER, PLAN_PROVIDERS, loadPlanProvider } from './plan/provider.js';

const USAGE = `rollcut record <spec.yaml> [options]
rollcut plan <url> [options]
rollcut capture <url> [options]
rollcut repair <spec.yaml> [options]

  --url <baseUrl>   Override the spec's baseUrl (preview deployments).
  --out <dir>       Output directory (default: out).
  --voice <name>    Override the spec's voice (names are provider-specific).
  --tts <name>      TTS provider: ${Object.keys(PROVIDERS).join(' | ')} (default: ${DEFAULT_PROVIDER}).
  --no-narration    Record silently; skip TTS and subtitles.
  --no-subtitles    Narrate, but do not burn subtitles.

Capture options:
  --readme <path>   Give the narrator your README for context.
  --llm <name>      Who writes the narration (default: the plan backend).
  --no-notes        Capture the steps only; write no narration.
  --out <file>      Write the spec here instead of stdout.

Repair options:
  --url <baseUrl>   Check against a different deployment.
  --out <file>      Write the mended spec here (default: in place).
  --check           Report only; change nothing. Exits non-zero if broken.
  --smart           Ask the LLM when word overlap finds no replacement.

Plan options:
  --readme <path>   Give the planner your README for context.
  --pages <n>       Pages to observe, landing page included (default: 4).
  --llm <name>      Planner backend: ${PLAN_PROVIDERS.join(' | ')} (default: ${DEFAULT_PLAN_PROVIDER}).
  --no-verify       Skip replaying the proposed spec in a browser.
  --out <file>      Write the proposed spec here instead of stdout.

Examples:
  pnpm rollcut record demos/excalidraw.yaml
  pnpm rollcut capture https://app.example.com --out demos/app.yaml
  pnpm rollcut plan https://excalidraw.com --readme README.md`;

interface Args {
  command: string | undefined;
  spec: string | undefined;
  url?: string;
  voice?: string;
  tts: string;
  out: string;
  readme?: string;
  planOut?: string;
  llm: string;
  pages?: number;
  verify: boolean;
  notes: boolean;
  check: boolean;
  smart: boolean;
  narration: boolean;
  subtitles: boolean;
}

function parseArgs(argv: string[]): Args {
  const [command, spec, ...rest] = argv;
  const args: Args = {
    command,
    spec,
    out: 'out',
    tts: process.env.ROLLCUT_TTS || DEFAULT_PROVIDER,
    llm: process.env.ROLLCUT_LLM || DEFAULT_PLAN_PROVIDER,
    verify: true,
    notes: true,
    check: false,
    smart: false,
    narration: true,
    subtitles: true,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--no-narration') {
      args.narration = false;
      continue;
    }
    if (flag === '--no-verify') {
      args.verify = false;
      continue;
    }
    if (flag === '--no-notes') {
      args.notes = false;
      continue;
    }
    if (flag === '--check') {
      args.check = true;
      continue;
    }
    if (flag === '--smart') {
      args.smart = true;
      continue;
    }
    if (flag === '--no-subtitles') {
      args.subtitles = false;
      continue;
    }
    const value = rest[++i];
    if (!value) throw new Error(`Flag ${flag} needs a value.\n\n${USAGE}`);
    if (flag === '--url') args.url = value;
    else if (flag === '--out') {
      args.out = value;
      args.planOut = value;
    } else if (flag === '--voice') args.voice = value;
    else if (flag === '--tts') args.tts = value;
    else if (flag === '--readme') args.readme = value;
    else if (flag === '--llm') args.llm = value;
    else if (flag === '--pages') args.pages = Number(value);
    else throw new Error(`Unknown flag ${flag}.\n\n${USAGE}`);
  }
  return args;
}

function human(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Propose a spec from a URL. Writes a file; never records anything. */
async function runPlan(args: Args): Promise<void> {
  const url = args.spec;
  if (!url) {
    console.error(USAGE);
    process.exit(1);
  }

  const readme = args.readme ? await readFile(args.readme, 'utf8') : undefined;
  const result = await plan({
    url,
    readme,
    provider: await loadPlanProvider(args.llm),
    maxPages: args.pages,
    verify: args.verify,
    log: (m) => console.error(m),
  });

  if (result.failures.length > 0) {
    console.error(
      `\nDropped ${result.failures.length} step(s) that failed when run:\n` +
        result.failures.map((f) => `  step ${f.step} (${f.kind}): ${f.reason}`).join('\n'),
    );
  }

  if (result.rejected.length > 0) {
    console.error(
      `\nDropped ${result.rejected.length} step(s) using selectors that are not on the page:\n` +
        result.rejected.map((r) => `  ${r}`).join('\n'),
    );
  }

  if (args.planOut) {
    await writeFile(args.planOut, result.yaml, 'utf8');
    console.error(`\nwrote ${args.planOut} — read it, edit it, then:`);
    console.error(`  pnpm rollcut record ${args.planOut}`);
  } else {
    console.log(result.yaml);
    console.error('\nReview this, save it, then run `rollcut record` on it.');
  }
}

/** Record a real run and turn it into a spec. Never records video. */
async function runCapture(args: Args): Promise<void> {
  const url = args.spec;
  if (!url) {
    console.error(USAGE);
    process.exit(1);
  }

  const { capture } = await import('./plan/capture.js');
  const { narrate } = await import('./plan/narrate.js');

  console.error(`opening ${url} — click through your demo, then press Finish.`);
  const captured = await capture({
    url,
    onAction: (a) =>
      console.error(`  ${a.kind}${a.selector ? ` ${a.selector}` : ''}${a.key ? ` ${a.key}` : ''}`),
  });

  if (captured.actions.length === 0) {
    throw new Error('Nothing was recorded. Interact with the page before pressing Finish.');
  }

  const readme = args.readme ? await readFile(args.readme, 'utf8') : undefined;
  const result = await narrate({
    capture: captured,
    provider: args.notes ? await loadPlanProvider(args.llm) : undefined,
    readme,
    log: (m) => console.error(m),
  });

  if (args.planOut) {
    await writeFile(args.planOut, result.yaml, 'utf8');
    console.error(
      `\nwrote ${args.planOut} — ${result.spec.steps.length} steps, ${result.narrated} narrated. Then:`,
    );
    console.error(`  pnpm rollcut record ${args.planOut}`);
  } else {
    console.log(result.yaml);
  }
}

/** Replay a spec against the live site and mend what no longer works. */
async function runRepair(args: Args): Promise<void> {
  const specPath = args.spec;
  if (!specPath) {
    console.error(USAGE);
    process.exit(1);
  }

  const { loadSpec } = await import('./spec/load.js');
  const { repair } = await import('./plan/repair.js');
  const yaml = (await import('js-yaml')).default;

  const spec = await loadSpec(resolve(specPath));
  console.error(`checking ${specPath} against ${args.url ?? spec.baseUrl}…`);

  let matcher;
  if (args.smart) {
    const { lexicalMatcher, modelMatcher, withFallback } = await import('./plan/match.js');
    // Deterministic first; the model is consulted only where it finds nothing.
    matcher = withFallback(lexicalMatcher, modelMatcher(await loadPlanProvider(args.llm)));
  }

  const result = await repair(spec, {
    url: args.url,
    matcher,
    onStep: (n, message) => console.error(`  step ${n}: ${message}`),
  });

  if (result.healthy) {
    console.error('\nEvery step still works. Nothing to change.');
    return;
  }

  for (const r of result.repairs) {
    console.error(`\nstep ${r.step}: ${r.from}\n         -> ${r.to}  (${r.because})`);
  }
  for (const u of result.unrepaired) {
    console.error(`\nstep ${u.step}: ${u.selector || '(no selector)'} — ${u.reason}`);
  }

  if (args.check) {
    // A reporting run must not rewrite the file it was asked to inspect.
    console.error(`\n${result.repairs.length} repairable, ${result.unrepaired.length} not.`);
    process.exit(1);
  }

  const target = args.planOut ?? specPath;
  await writeFile(target, yaml.dump(result.spec, { lineWidth: 100, quotingType: '"' }), 'utf8');
  console.error(`\nwrote ${target} — read the diff before committing it.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'repair') {
    await runRepair(args);
    return;
  }

  if (args.command === 'capture') {
    await runCapture(args);
    return;
  }

  if (args.command === 'plan') {
    await runPlan(args);
    return;
  }

  if (args.command !== 'record' || !args.spec) {
    console.error(USAGE);
    process.exit(1);
  }

  const started = Date.now();
  const result = await runPipeline({
    specPath: args.spec,
    outDir: args.out,
    url: args.url,
    voice: args.voice,
    tts: args.tts,
    narration: args.narration,
    subtitles: args.subtitles,
    log: (m) => console.log(m),
  });

  const [m, g] = await Promise.all([stat(result.mp4), stat(result.gif)]);
  console.log(
    `\n${result.mp4}  ${human(m.size)}  ${result.durationSeconds.toFixed(1)}s  ` +
      `${result.narrated ? `narrated (${result.lines} lines)` : 'silent'}`,
  );
  console.log(
    `${result.gif}  ${human(g.size)}  silent${result.gifOversize ? '  ⚠ over 8 MB — too large to embed in a README' : ''}`,
  );
  if (result.srt) console.log(`${result.srt}`);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err: Error) => {
  console.error(`\nrollcut: ${err.message}`);
  process.exit(1);
});
