import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSpec } from './spec/load.js';
import { record } from './record/driver.js';
import { assemble } from './media/assemble.js';
import { planNarration } from './tts/provider.js';
import { edgeTts } from './tts/edge.js';
import { kokoroTts } from './tts/kokoro.js';
export const PROVIDERS = {
    kokoro: kokoroTts,
    edge: edgeTts,
};
/** Local, and Apache-2.0 all the way down, so generated speech is publishable. */
export const DEFAULT_PROVIDER = 'kokoro';
/**
 * spec -> narrate -> record -> assemble. Narration is synthesized before
 * recording so each step can be held for exactly as long as its line takes.
 */
export async function runPipeline(options) {
    const log = options.log ?? (() => undefined);
    const outDir = resolve(options.outDir);
    const workDir = resolve(outDir, '.work');
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const spec = await loadSpec(resolve(options.specPath));
    log(`spec: ${options.specPath} — ${spec.steps.length} steps @ ${spec.viewport.width}x${spec.viewport.height}${spec.scale > 1 ? ` (${spec.scale}x)` : ''}`);
    const narration = new Map();
    if (options.narration !== false) {
        const notes = spec.steps
            .map((step, stepIndex) => ({ stepIndex, text: step.note ?? '' }))
            .filter((n) => n.text.trim().length > 0);
        if (notes.length > 0) {
            const name = options.tts || DEFAULT_PROVIDER;
            const provider = PROVIDERS[name];
            if (!provider) {
                throw new Error(`Unknown TTS provider \`${name}\`. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);
            }
            log(`narrating ${notes.length} notes with ${provider.name}…`);
            const clips = await planNarration(notes, options.voice ?? spec.voice, workDir, provider, (n) => log(`  note ${n.stepIndex + 1}: ${(n.durationMs / 1000).toFixed(1)}s "${n.text}"`));
            for (const clip of clips)
                narration.set(clip.stepIndex, clip);
        }
    }
    const { raw, cues, zooms } = await record(spec, {
        workDir,
        url: options.url,
        narration,
        onStep: (n, what) => log(`  step ${n}: ${what}`),
    });
    log('assembling…');
    // The video is `scale` times the viewport; zooms and subtitles work in its pixels.
    const frame = {
        width: spec.viewport.width * spec.scale,
        height: spec.viewport.height * spec.scale,
    };
    const result = await assemble(raw, {
        outDir,
        workDir,
        cues,
        subtitles: options.subtitles,
        viewport: frame,
        scale: spec.scale,
        zooms: zooms.map((z) => ({ ...z, x: z.x * spec.scale, y: z.y * spec.scale })),
    });
    await rm(workDir, { recursive: true, force: true });
    return { ...result, steps: spec.steps.length, lines: cues.length };
}
//# sourceMappingURL=pipeline.js.map