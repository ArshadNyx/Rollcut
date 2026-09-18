#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { DEFAULT_PROVIDER, PROVIDERS, runPipeline } from './pipeline.js';
const USAGE = `rollcut record <spec.yaml> [options]

  --url <baseUrl>   Override the spec's baseUrl (preview deployments).
  --out <dir>       Output directory (default: out).
  --voice <name>    Override the spec's voice (names are provider-specific).
  --tts <name>      TTS provider: ${Object.keys(PROVIDERS).join(' | ')} (default: ${DEFAULT_PROVIDER}).
  --no-narration    Record silently; skip TTS and subtitles.
  --no-subtitles    Narrate, but do not burn subtitles.

Example:
  pnpm rollcut record demos/excalidraw.yaml`;
function parseArgs(argv) {
    const [command, spec, ...rest] = argv;
    const args = {
        command,
        spec,
        out: 'out',
        tts: process.env.ROLLCUT_TTS || DEFAULT_PROVIDER,
        narration: true,
        subtitles: true,
    };
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === '--no-narration') {
            args.narration = false;
            continue;
        }
        if (flag === '--no-subtitles') {
            args.subtitles = false;
            continue;
        }
        const value = rest[++i];
        if (!value)
            throw new Error(`Flag ${flag} needs a value.\n\n${USAGE}`);
        if (flag === '--url')
            args.url = value;
        else if (flag === '--out')
            args.out = value;
        else if (flag === '--voice')
            args.voice = value;
        else if (flag === '--tts')
            args.tts = value;
        else
            throw new Error(`Unknown flag ${flag}.\n\n${USAGE}`);
    }
    return args;
}
function human(bytes) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
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
    console.log(`\n${result.mp4}  ${human(m.size)}  ${result.durationSeconds.toFixed(1)}s  ` +
        `${result.narrated ? `narrated (${result.lines} lines)` : 'silent'}`);
    console.log(`${result.gif}  ${human(g.size)}  silent${result.gifOversize ? '  ⚠ over 8 MB — too large to embed in a README' : ''}`);
    if (result.srt)
        console.log(`${result.srt}`);
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
main().catch((err) => {
    console.error(`\nrollcut: ${err.message}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map