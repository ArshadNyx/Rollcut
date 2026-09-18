import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { getOctokit, context } from '@actions/github';

export interface ReleaseAsset {
  path: string;
  contentType: string;
}

export interface AttachOptions {
  token: string;
  /** Release to attach to; defaults to the one that triggered the run. */
  releaseId?: number;
  assets: ReleaseAsset[];
  onUpload?: (name: string, url: string) => void;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.gif': 'image/gif',
  '.srt': 'application/x-subrip',
};

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve the release this run is about. `release` events carry it directly;
 * a tag push has to be looked up.
 */
export async function resolveReleaseId(token: string): Promise<number | undefined> {
  const payloadId = (context.payload.release as { id?: number } | undefined)?.id;
  if (payloadId) return payloadId;

  const tag = context.ref.startsWith('refs/tags/')
    ? context.ref.slice('refs/tags/'.length)
    : undefined;
  if (!tag) return undefined;

  const octokit = getOctokit(token);
  try {
    const { data } = await octokit.rest.repos.getReleaseByTag({
      ...context.repo,
      tag,
    });
    return data.id;
  } catch {
    return undefined;
  }
}

/**
 * Upload each asset to the release, replacing any same-named asset so re-runs
 * of a workflow are idempotent rather than erroring on a duplicate name.
 */
export async function attachToRelease(options: AttachOptions): Promise<string[]> {
  const { token, assets } = options;
  const releaseId = options.releaseId ?? (await resolveReleaseId(token));
  if (!releaseId) {
    throw new Error(
      'No release found for this run. Trigger Rollcut from a `release` event, or set `attach-to-release: false`.',
    );
  }

  const octokit = getOctokit(token);
  const { data: existing } = await octokit.rest.repos.listReleaseAssets({
    ...context.repo,
    release_id: releaseId,
    per_page: 100,
  });

  const urls: string[] = [];
  for (const asset of assets) {
    const name = basename(asset.path);
    const clash = existing.find((a) => a.name === name);
    if (clash) {
      await octokit.rest.repos.deleteReleaseAsset({ ...context.repo, asset_id: clash.id });
    }

    const { size } = await stat(asset.path);
    const data = await readFile(asset.path);
    const { data: uploaded } = await octokit.rest.repos.uploadReleaseAsset({
      ...context.repo,
      release_id: releaseId,
      name,
      headers: { 'content-type': asset.contentType, 'content-length': size },
      // octokit's types want a string here; a Buffer is what actually works.
      data: data as unknown as string,
    });
    urls.push(uploaded.browser_download_url);
    options.onUpload?.(name, uploaded.browser_download_url);
  }
  return urls;
}
