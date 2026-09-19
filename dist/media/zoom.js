export const ZOOM_SCALE = 1.15;
export const ZOOM_TIMING = { inMs: 620, holdMs: 520, outMs: 820 };
export const ZOOM_TOTAL_MS = ZOOM_TIMING.inMs + ZOOM_TIMING.holdMs + ZOOM_TIMING.outMs;
/** Smoothstep: eases both ends, so nothing starts or stops abruptly. */
function smoothstep(progress) {
    return `(${progress})*(${progress})*(3-2*(${progress}))`;
}
/**
 * One click's contribution to the zoom envelope, in 0..1.
 *
 * Segments are half-open (`gte` … `lt`) rather than `between()`, which is
 * inclusive at both ends and would double-count a frame on each boundary.
 */
function envelope(event, timing) {
    const start = event.atMs / 1000;
    const inEnd = start + timing.inMs / 1000;
    const holdEnd = inEnd + timing.holdMs / 1000;
    const outEnd = holdEnd + timing.outMs / 1000;
    const rampIn = smoothstep(`(in_time-${start.toFixed(3)})/${(timing.inMs / 1000).toFixed(3)}`);
    const rampOut = smoothstep(`1-(in_time-${holdEnd.toFixed(3)})/${(timing.outMs / 1000).toFixed(3)}`);
    return [
        `gte(in_time,${start.toFixed(3)})*lt(in_time,${inEnd.toFixed(3)})*${rampIn}`,
        `gte(in_time,${inEnd.toFixed(3)})*lt(in_time,${holdEnd.toFixed(3)})`,
        `gte(in_time,${holdEnd.toFixed(3)})*lt(in_time,${outEnd.toFixed(3)})*${rampOut}`,
    ].join('+');
}
/**
 * Build the filter that performs every zoom.
 *
 * The zoom is done here rather than in the page because a CSS transform on
 * `<html>` makes `position: fixed` resolve against the transformed element:
 * sticky headers detach and, on a scrolled page, disappear entirely for the
 * length of the zoom. Cropping the finished recording cannot disturb a layout
 * that has already been captured.
 *
 * `zoompan` rather than `crop`: crop only evaluates its width and height once,
 * before `t` exists, so the cropped size cannot change over time. zoompan
 * re-evaluates every expression per frame, which is the whole point.
 *
 * Returns undefined when there is nothing to zoom, so callers can skip it.
 */
export function buildZoomFilter(events, options) {
    const usable = events.filter((e) => Number.isFinite(e.atMs) && e.atMs >= 0);
    if (usable.length === 0)
        return undefined;
    const scale = options.scale ?? ZOOM_SCALE;
    const timing = options.timing ?? ZOOM_TIMING;
    const fps = options.fps ?? 30;
    const { width, height } = options;
    // Envelopes never overlap in practice — a step is held for the whole zoom —
    // but clamp anyway so a tight spec cannot scale past the intended maximum.
    const sum = usable.map((event) => envelope(event, timing)).join('+');
    const z = `(1+${(scale - 1).toFixed(4)}*clip(${sum},0,1))`;
    // Keep the clicked point where it is on screen: the source window's offset
    // is that point scaled by the share of the frame being dropped.
    //
    // The focus is a weighted *average* of the active clicks, not a weighted
    // sum. Without dividing by the total weight the point slides toward the
    // frame's origin while the zoom ramps, so the picture drifts on the way in
    // and back on the way out.
    const weight = `max(${sum},0.0001)`;
    const focusX = `(${usable
        .map((e) => `${e.x.toFixed(1)}*(${envelope(e, timing)})`)
        .join('+')})/${weight}`;
    const focusY = `(${usable
        .map((e) => `${e.y.toFixed(1)}*(${envelope(e, timing)})`)
        .join('+')})/${weight}`;
    const ss = options.supersample ?? 2;
    const fx = ss > 1 ? `(${focusX})*${ss}` : `(${focusX})`;
    const fy = ss > 1 ? `(${focusY})*${ss}` : `(${focusY})`;
    const x = `clip(${fx}*(1-1/${z}),0,iw-iw/${z})`;
    const y = `clip(${fy}*(1-1/${z}),0,ih-ih/${z})`;
    // zoompan rounds its source window to whole pixels. At a 1.15x zoom that
    // rounding is a visible wobble, so the frame is supersampled first: the same
    // rounding then lands on half a source pixel instead of a whole one.
    const supersample = options.supersample ?? 2;
    const prefix = supersample > 1 ? `scale=iw*${supersample}:ih*${supersample}:flags=bicubic,` : '';
    // d=1 makes zoompan emit one frame per input frame instead of holding each
    // one for a pan; without it a short clip stretches to minutes.
    return `${prefix}zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}
//# sourceMappingURL=zoom.js.map