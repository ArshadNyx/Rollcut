export const DEFAULT_STYLE = {
    fontName: 'Arial',
    width: 1280,
    height: 720,
    fontSize: 27,
    marginH: 80,
    marginV: 44,
};
/**
 * Notes are meant to sit on one line. Arial's average advance for mixed-case
 * English is a little over half the em; 0.52 leaves a margin for error so a
 * line never runs into the safe area.
 */
export function maxChars(style = DEFAULT_STYLE) {
    return Math.floor((style.width - 2 * style.marginH) / (style.fontSize * 0.52));
}
function pad(n, w = 2) {
    return String(n).padStart(w, '0');
}
function srtTime(ms) {
    const t = Math.max(0, Math.round(ms));
    return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor((t % 3_600_000) / 60_000))}:${pad(Math.floor((t % 60_000) / 1000))},${pad(t % 1000, 3)}`;
}
function assTime(ms) {
    const t = Math.max(0, Math.round(ms));
    const cs = Math.round((t % 1000) / 10);
    return `${Math.floor(t / 3_600_000)}:${pad(Math.floor((t % 3_600_000) / 60_000))}:${pad(Math.floor((t % 60_000) / 1000))}.${pad(cs)}`;
}
/**
 * Keep a note on one line. Only when it genuinely cannot fit between the safe
 * margins do we split it, and then near the middle so the two lines balance.
 */
export function wrap(text, limit = maxChars()) {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (clean.length <= limit)
        return [clean];
    const words = clean.split(' ');
    const target = clean.length / 2;
    let best = { index: 1, distance: Infinity };
    let width = 0;
    for (let i = 0; i < words.length - 1; i++) {
        width += words[i].length + (i > 0 ? 1 : 0);
        const distance = Math.abs(width - target);
        if (distance < best.distance)
            best = { index: i + 1, distance };
    }
    return [words.slice(0, best.index).join(' '), words.slice(best.index).join(' ')];
}
function usable(cues) {
    return cues.filter((c) => c.endMs > c.startMs && c.text.trim());
}
/** Sidecar SRT, for players and for anyone who wants to re-time by hand. */
export function toSrt(cues) {
    return (usable(cues)
        .map((cue, i) => [
        String(i + 1),
        `${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}`,
        wrap(cue.text).join('\n'),
        '',
    ].join('\n'))
        .join('\n') + '\n');
}
/**
 * ASS is what actually gets burned. Declaring PlayResX/PlayResY equal to the
 * video means FontSize and margins are plain pixels instead of libass's
 * default 288-high reference, which silently scales text to ~2x.
 */
export function toAss(cues, style = DEFAULT_STYLE) {
    const header = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${style.width}`,
        `PlayResY: ${style.height}`,
        'WrapStyle: 2',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
            ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,' +
            ' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // Outline + soft shadow rather than an opaque box: readable over light and
        // dark UI without covering the app being demoed.
        `Style: Rollcut,${style.fontName},${style.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,` +
            `-1,0,0,0,100,100,0,0,1,3,1.5,2,${style.marginH},${style.marginH},${style.marginV},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const events = usable(cues).map((cue) => `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Rollcut,,0,0,0,,` +
        wrap(cue.text, maxChars(style)).join('\\N'));
    return [...header, ...events, ''].join('\n');
}
//# sourceMappingURL=subtitles.js.map