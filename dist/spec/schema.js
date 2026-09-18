import { z } from 'zod';
const point = z.tuple([z.number(), z.number()]);
const withNote = { note: z.string().optional() };
export const stepSchema = z.union([
    z.object({ navigate: z.string(), ...withNote }).strict(),
    z.object({ click: z.string(), ...withNote }).strict(),
    z.object({ clickAt: point, ...withNote }).strict(),
    z.object({ drag: z.object({ from: point, to: point }).strict(), ...withNote }).strict(),
    z.object({ type: z.string(), ...withNote }).strict(),
    z.object({ press: z.string(), ...withNote }).strict(),
    z.object({ wait: z.number().int().nonnegative(), ...withNote }).strict(),
    // Pixels to scroll by, or a selector to bring into view.
    z.object({ scroll: z.union([z.number(), z.string()]), ...withNote }).strict(),
    z.object({ hover: z.string(), ...withNote }).strict(),
    z.object({ waitFor: z.string(), ...withNote }).strict(),
]);
export const specSchema = z
    .object({
    baseUrl: z.string().url(),
    viewport: z
        .object({ width: z.number().int().positive(), height: z.number().int().positive() })
        .strict()
        .default({ width: 1280, height: 720 }),
    pauseMs: z.number().int().nonnegative().default(700),
    voice: z.string().optional(),
    steps: z.array(stepSchema).min(1),
})
    .strict();
/** The one non-`note` key of a step — what the executor dispatches on. */
export function stepKind(step) {
    const keys = Object.keys(step).filter((k) => k !== 'note');
    return keys[0];
}
//# sourceMappingURL=schema.js.map