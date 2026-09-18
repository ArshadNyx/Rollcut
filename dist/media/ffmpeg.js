import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
const BIN = ffmpegPath;
const debug = process.env.ROLLCUT_DEBUG === '1' || process.env.RUNNER_DEBUG === '1';
/**
 * The single entry point for every ffmpeg invocation in Rollcut.
 * Always logs its full argv at debug level; never hides it.
 */
export async function ffmpeg(args) {
    if (!BIN) {
        throw new Error('ffmpeg-static did not provide a binary for this platform — run `pnpm install` again, or set ROLLCUT_FFMPEG to an ffmpeg on your PATH.');
    }
    const bin = process.env.ROLLCUT_FFMPEG || BIN;
    const argv = ['-hide_banner', '-nostdin', '-y', ...args];
    if (debug)
        console.error(`[ffmpeg] ${bin} ${argv.join(' ')}`);
    await new Promise((resolve, reject) => {
        const child = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (c) => {
            stderr += String(c);
            if (debug)
                process.stderr.write(c);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0)
                return resolve();
            reject(new Error(`ffmpeg exited ${code}. Command:\n  ${bin} ${argv.join(' ')}\n${stderr.split('\n').slice(-20).join('\n')}`));
        });
    });
}
//# sourceMappingURL=ffmpeg.js.map