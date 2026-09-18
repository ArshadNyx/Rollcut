import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as core from '@actions/core';
import { runPipeline } from './pipeline.js';
import { attachToRelease, contentTypeFor } from './publish/release.js';

function boolInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === 'yes' || raw === '1';
}

async function main(): Promise<void> {
  const spec = core.getInput('spec', { required: true });
  const url = core.getInput('url') || undefined;
  const voice = core.getInput('voice') || undefined;
  const tts = core.getInput('tts') || undefined;
  const outDir = core.getInput('out') || 'out';
  const attach = boolInput('attach-to-release', true);
  const updateReadme = boolInput('update-readme', false);
  const token = core.getInput('token');

  const result = await runPipeline({
    specPath: spec,
    outDir,
    url,
    voice,
    tts,
    narration: boolInput('narration', true),
    subtitles: boolInput('subtitles', true),
    log: (m) => core.info(m),
  });

  core.setOutput('mp4', result.mp4);
  core.setOutput('gif', result.gif);
  core.setOutput('duration-seconds', result.durationSeconds.toFixed(2));

  const [mp4Stat, gifStat] = await Promise.all([stat(result.mp4), stat(result.gif)]);
  await core.summary
    .addHeading('Rollcut demo')
    .addTable([
      [
        { data: 'Asset', header: true },
        { data: 'Size', header: true },
        { data: 'Detail', header: true },
      ],
      [
        'demo.mp4',
        `${(mp4Stat.size / 1_000_000).toFixed(1)} MB`,
        `${result.durationSeconds.toFixed(1)}s, ${result.narrated ? `${result.lines} narrated lines` : 'silent'}`,
      ],
      ['demo.gif', `${(gifStat.size / 1_000_000).toFixed(1)} MB`, 'silent'],
    ])
    .write();

  if (attach) {
    if (!token) {
      throw new Error(
        'attach-to-release is on but no `token` was provided. Pass `token: ${{ github.token }}`.',
      );
    }
    const assets = [result.mp4, result.gif, result.srt]
      .filter((p): p is string => Boolean(p))
      .map((path) => ({ path: resolve(path), contentType: contentTypeFor(path) }));

    const urls = await attachToRelease({
      token,
      assets,
      onUpload: (name, downloadUrl) => core.info(`uploaded ${name} → ${downloadUrl}`),
    });
    core.setOutput('asset-urls', urls.join('\n'));
  }

  if (updateReadme) {
    // Declared in the interface from day one; the committing side lands in
    // phase 4. Warn rather than fail — this must never break someone's release.
    core.warning(
      'update-readme is not implemented yet (phase 4). The video was still produced and attached.',
    );
  }
}

main().catch((err: Error) => {
  core.setFailed(err.message);
});
