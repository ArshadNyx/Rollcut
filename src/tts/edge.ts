import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { toWav, wavDurationMs, type Clip, type TtsProvider } from './provider.js';

const run = promisify(execFile);

export const DEFAULT_VOICE = 'en-US-AriaNeural';

/** `python3` on most runners; overridable for venvs and Windows. */
const PYTHON = process.env.ROLLCUT_PYTHON || 'python3';

let checked = false;

async function ensureAvailable(): Promise<void> {
  if (checked) return;
  try {
    await run(PYTHON, ['-m', 'edge_tts', '--version']);
  } catch {
    throw new Error(
      `edge-tts is not available via \`${PYTHON} -m edge_tts\`. Install it with:\n` +
        `  ${PYTHON} -m pip install --user edge-tts\n` +
        "Or point ROLLCUT_PYTHON at a Python that has it. Narration needs network access to Microsoft's TTS endpoint.",
    );
  }
  checked = true;
}

/**
 * Phase-1 provider: Microsoft Edge's neural voices through the edge-tts CLI.
 * Emits mp3, which we decode to the canonical wav so durations are exact.
 */
export const edgeTts: TtsProvider = {
  name: 'edge-tts',

  async synthesize(text, voice, outPath): Promise<Clip> {
    await ensureAvailable();
    const mp3 = `${outPath}.mp3`;
    try {
      await run(PYTHON, [
        '-m',
        'edge_tts',
        '--voice',
        voice || DEFAULT_VOICE,
        '--text',
        text,
        '--write-media',
        mp3,
      ]);
    } catch (e) {
      const detail =
        (e as { stderr?: string }).stderr?.trim().split('\n').slice(-3).join(' ') ?? '';
      throw new Error(
        `edge-tts failed on "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" with voice \`${voice || DEFAULT_VOICE}\`. ` +
          `Check the voice name against \`${PYTHON} -m edge_tts --list-voices\` and that you are online. ${detail}`,
        { cause: e },
      );
    }
    await toWav(mp3, outPath);
    await rm(mp3, { force: true });
    return { wavPath: outPath, durationMs: await wavDurationMs(outPath) };
  },
};
