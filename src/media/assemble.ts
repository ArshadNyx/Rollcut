import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg } from './ffmpeg.js';
import { DEFAULT_STYLE, toAss, toSrt, type Cue } from './subtitles.js';
import { buildZoomFilter, type ZoomEvent } from './zoom.js';

export interface NarrationCue extends Cue {
  wavPath: string;
}

export interface AssembleOptions {
  outDir: string;
  workDir: string;
  cues: NarrationCue[];
  /** Burn subtitles into the mp4. */
  subtitles?: boolean;
  /** Video size, so subtitle sizing matches the frame. */
  viewport?: { width: number; height: number };
  /** Clicks to zoom toward. */
  zooms?: ZoomEvent[];
}

export interface AssembleResult {
  mp4: string;
  gif: string;
  /** Set when the GIF exceeds GIF_MAX_BYTES, so callers can warn. */
  gifOversize: boolean;
  srt: string | undefined;
  durationSeconds: number;
  narrated: boolean;
}

/** Above this a GIF stops being embeddable in a README. */
export const GIF_MAX_BYTES = 8_000_000;

const GIF_FPS = 12;
const GIF_WIDTH = 800;

/** libass paths travel through a filter string; colons and backslashes bite. */
function escapeForFilter(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * One pass: scale/pad the raw capture, burn subtitles, delay each narration
 * clip to its cue time and mix them into a single track.
 */
export async function toMp4(
  raw: string,
  outPath: string,
  options: {
    cues: NarrationCue[];
    assPath?: string;
    zooms?: ZoomEvent[];
    viewport?: { width: number; height: number };
  },
): Promise<boolean> {
  const { cues, assPath } = options;
  // `apad` produces an endless stream and `-shortest` does not reliably stop a
  // filter_complex output, so the capture's own length is the hard bound.
  const videoSeconds = await probeDurationSeconds(raw);
  const fps = await probeFrameRate(raw);
  const args: string[] = ['-i', raw];
  for (const cue of cues) args.push('-i', cue.wavPath);

  const chains: string[] = [];
  // No fps conversion: resampling 25 -> 30 duplicates every fifth frame, and a
  // duplicate mid-zoom reads as a stutter.
  let video = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

  // Zoom before subtitles, so the text is burned at full size onto the final
  // frame rather than being magnified along with the page.
  const zoom =
    options.viewport &&
    buildZoomFilter(options.zooms ?? [], {
      width: options.viewport.width,
      height: options.viewport.height,
      fps,
    });
  if (zoom) video += `,${zoom}`;

  // The ASS file carries its own styling and resolution, so no force_style.
  if (assPath) video += `,ass='${escapeForFilter(assPath)}'`;
  chains.push(`[0:v]${video}[v]`);

  if (cues.length > 0) {
    cues.forEach((cue, i) => {
      const delay = Math.max(0, Math.round(cue.startMs));
      chains.push(`[${i + 1}:a]adelay=${delay}:all=1[n${i}]`);
    });
    const inputs = cues.map((_, i) => `[n${i}]`).join('');
    // normalize=0 keeps a single speaking voice at full level.
    chains.push(`${inputs}amix=inputs=${cues.length}:normalize=0[mixed]`);
    // Pad only when we have a hard bound to cut against.
    chains.push(videoSeconds > 0 ? '[mixed]apad[a]' : '[mixed]anull[a]');
  }

  args.push('-filter_complex', chains.join(';'), '-map', '[v]');
  if (cues.length > 0) {
    args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  // prettier-ignore
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );
  if (videoSeconds > 0) args.push('-t', videoSeconds.toFixed(3));
  args.push(outPath);

  await ffmpeg(args);
  return cues.length > 0;
}

/** Palette-based GIF so gradients and UI chrome do not band. The GIF is silent. */
export async function toGif(raw: string, outPath: string, zoom?: string): Promise<string> {
  const filters =
    `${zoom ? `${zoom},` : ''}fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=192:stats_mode=diff[p];` +
    `[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  await ffmpeg(['-i', raw, '-filter_complex', filters, '-loop', '0', outPath]);
  return outPath;
}

/**
 * Frames per second of a capture.
 *
 * Resampling to a different rate duplicates frames, and a duplicated frame in
 * the middle of a zoom reads as a stutter — so the output keeps the rate it
 * was recorded at.
 */
export async function probeFrameRate(file: string, fallback = 25): Promise<number> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string;
  const run = promisify(execFile);
  try {
    const { stderr } = await run(process.env.ROLLCUT_FFMPEG || ffmpegStatic, [
      '-hide_banner',
      '-i',
      file,
    ]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
    const m = /,\s*([0-9]+(?:\.[0-9]+)?)\s*fps/.exec(stderr ?? '');
    const fps = m?.[1] ? Number(m[1]) : Number.NaN;
    return Number.isFinite(fps) && fps > 0 ? fps : fallback;
  } catch {
    return fallback;
  }
}

export async function probeDurationSeconds(file: string): Promise<number> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string;
  const run = promisify(execFile);
  try {
    const { stderr } = await run(process.env.ROLLCUT_FFMPEG || ffmpegStatic, [
      '-hide_banner',
      '-i',
      file,
    ]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr ?? '');
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return 0;
  }
}

export async function assemble(raw: string, options: AssembleOptions): Promise<AssembleResult> {
  const { outDir, workDir, cues } = options;

  const style = { ...DEFAULT_STYLE, ...(options.viewport ?? {}) };

  let assPath: string | undefined;
  let srtOut: string | undefined;
  if (options.subtitles !== false && cues.length > 0) {
    assPath = join(workDir, 'demo.ass');
    await writeFile(assPath, toAss(cues, style), 'utf8');
    // Sidecar SRT ships alongside the video for players and manual re-timing.
    srtOut = join(outDir, 'demo.srt');
    await writeFile(srtOut, toSrt(cues), 'utf8');
  }

  // The GIF gets the same zoom, so the two tell the same story.
  const zoomFilter = buildZoomFilter(options.zooms ?? [], {
    width: style.width,
    height: style.height,
    fps: await probeFrameRate(raw),
  });

  const mp4 = join(outDir, 'demo.mp4');
  const narrated = await toMp4(raw, mp4, {
    cues,
    assPath,
    zooms: options.zooms,
    viewport: style,
  });
  const gif = await toGif(raw, join(outDir, 'demo.gif'), zoomFilter);

  await stat(mp4);
  const gifStat = await stat(gif);
  return {
    mp4,
    gif,
    gifOversize: gifStat.size > GIF_MAX_BYTES,
    srt: srtOut,
    durationSeconds: await probeDurationSeconds(mp4),
    narrated,
  };
}
