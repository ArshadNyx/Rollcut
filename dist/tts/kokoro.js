import { rm } from 'node:fs/promises';
import { toWav, wavDurationMs } from './provider.js';
/** Apache-2.0 model and weights — safe to redistribute the generated audio. */
const MODEL_ID = process.env.ROLLCUT_KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** q8 is the best size/quality trade for CI; override for a nicer voice. */
const DTYPE = (process.env.ROLLCUT_KOKORO_DTYPE || 'q8');
export const DEFAULT_VOICE = 'af_heart';
// The model is ~80 MB quantized and takes seconds to load, so it is loaded
// once per process and shared across every note in the spec.
let modelPromise;
async function load(onProgress) {
    if (!modelPromise) {
        modelPromise = (async () => {
            let KokoroTTS;
            try {
                ({ KokoroTTS } = await import('kokoro-js'));
            }
            catch (e) {
                // Optional dependency: installed by default, but skipped with
                // --no-optional and unavailable where onnxruntime has no prebuilt.
                throw new Error('The kokoro TTS provider needs `kokoro-js`, which is an optional dependency and is not installed here.\n' +
                    '  Install it:        pnpm add kokoro-js\n' +
                    '  Or use Edge:       --tts edge\n' +
                    '  Or skip narration: --no-narration', { cause: e });
            }
            onProgress?.(`loading ${MODEL_ID} (${DTYPE}) — first run downloads the model`);
            return (await KokoroTTS.from_pretrained(MODEL_ID, {
                dtype: DTYPE,
                device: 'cpu',
            }));
        })();
    }
    return modelPromise;
}
/**
 * Local neural TTS. Nothing leaves the machine, and both the library and the
 * weights are Apache-2.0, so users may publish the generated speech.
 */
export const kokoroTts = {
    name: 'kokoro',
    async synthesize(text, voice, outPath) {
        const model = await load((m) => console.log(`  ${m}`));
        const selected = voice || DEFAULT_VOICE;
        if (!(selected in model.voices)) {
            const available = Object.keys(model.voices);
            throw new Error(`Unknown kokoro voice \`${selected}\`. Kokoro uses its own names (not Edge's) — try \`${DEFAULT_VOICE}\`. ` +
                `Available: ${available.slice(0, 12).join(', ')}${available.length > 12 ? ', …' : ''}`);
        }
        const native = `${outPath}.kokoro.wav`;
        const audio = await model.generate(text, { voice: selected });
        await audio.save(native);
        // Kokoro emits 24 kHz; resample to the canonical format so timing and
        // mixing behave identically no matter which provider produced the clip.
        await toWav(native, outPath);
        await rm(native, { force: true });
        return { wavPath: outPath, durationMs: await wavDurationMs(outPath) };
    },
};
//# sourceMappingURL=kokoro.js.map