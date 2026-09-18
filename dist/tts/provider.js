import { stat } from 'node:fs/promises';
import { ffmpeg } from '../media/ffmpeg.js';
/** Every provider decodes to this format so assembly never has to branch. */
export const WAV_RATE = 48_000;
export const WAV_CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
/** Decode any audio file the provider produced into the canonical wav. */
export async function toWav(input, outPath) {
    // prettier-ignore
    await ffmpeg([
        '-i', input,
        '-ac', String(WAV_CHANNELS),
        '-ar', String(WAV_RATE),
        '-c:a', 'pcm_s16le',
        outPath,
    ]);
    return outPath;
}
/**
 * Exact duration from the PCM payload size — no ffprobe, no rounding surprises.
 * Timing accuracy here is what keeps audio and video from drifting.
 */
export async function wavDurationMs(wavPath) {
    const { size } = await stat(wavPath);
    const samples = Math.max(0, size - WAV_HEADER_BYTES) / (BYTES_PER_SAMPLE * WAV_CHANNELS);
    return Math.round((samples / WAV_RATE) * 1000);
}
/**
 * Synthesize every note in the spec *before* recording starts, so the recorder
 * knows exactly how long to hold each step. Measuring after the fact would let
 * audio and video drift, which is the one thing this product cannot get wrong.
 */
export async function planNarration(notes, voice, dir, provider, onClip) {
    const { join } = await import('node:path');
    const out = [];
    for (const { stepIndex, text } of notes) {
        const clip = await provider.synthesize(text, voice, join(dir, `note-${String(stepIndex).padStart(2, '0')}.wav`));
        const narration = { ...clip, stepIndex, text };
        out.push(narration);
        onClip?.(narration);
    }
    return out;
}
//# sourceMappingURL=provider.js.map