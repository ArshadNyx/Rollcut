import { getOctokit, context } from '@actions/github';
const START = '<!-- rollcut:start -->';
const END = '<!-- rollcut:end -->';
/** The generated markdown: a badge, the GIF, and a link to the full video. */
export function renderBlock(block) {
    const seconds = block.durationSeconds.toFixed(1);
    const badge = `![Demo](https://img.shields.io/badge/demo-${encodeURIComponent(`${seconds}s`)}-8b5cf6)`;
    return [
        START,
        '',
        badge,
        '',
        `[![Demo](${block.gifUrl})](${block.mp4Url})`,
        '',
        `*Recorded automatically by [Rollcut](https://rollcut.dev) for \`${block.tag}\`.*`,
        '',
        END,
    ].join('\n');
}
/**
 * Insert or replace the Rollcut block. Idempotent: running twice produces the
 * same file, so a re-run never stacks duplicate embeds.
 */
export function applyBlock(readme, rendered) {
    const start = readme.indexOf(START);
    const end = readme.indexOf(END);
    if (start !== -1 && end !== -1 && end > start) {
        return readme.slice(0, start) + rendered + readme.slice(end + END.length);
    }
    // No markers yet: place it directly under the first heading, which is where
    // a reader looks first. Failing that, at the top.
    const lines = readme.split('\n');
    const heading = lines.findIndex((l) => l.startsWith('# '));
    if (heading === -1)
        return `${rendered}\n\n${readme}`;
    lines.splice(heading + 1, 0, '', rendered);
    return lines.join('\n');
}
/** Commit the badge and GIF embed to the repository's README. */
export async function updateReadme(options) {
    const path = options.path ?? 'README.md';
    const octokit = getOctokit(options.token);
    let existing = '';
    let sha;
    try {
        const { data } = await octokit.rest.repos.getContent({ ...context.repo, path });
        if (!('content' in data)) {
            throw new Error(`\`${path}\` is not a file in this repository.`);
        }
        existing = Buffer.from(data.content, 'base64').toString('utf8');
        sha = data.sha;
    }
    catch (e) {
        if (e.status !== 404)
            throw e;
        // No README yet — create one.
    }
    const updated = applyBlock(existing, renderBlock(options.block));
    if (updated === existing) {
        options.onResult?.('README already up to date; nothing to commit.');
        return false;
    }
    await octokit.rest.repos.createOrUpdateFileContents({
        ...context.repo,
        path,
        message: `docs: update demo for ${options.block.tag}`,
        content: Buffer.from(updated, 'utf8').toString('base64'),
        sha,
    });
    options.onResult?.(`committed ${path} with the demo for ${options.block.tag}`);
    return true;
}
//# sourceMappingURL=readme.js.map