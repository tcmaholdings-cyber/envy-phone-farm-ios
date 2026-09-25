/**
 * Irreversible side effects (a public TikTok post, a saved draft) must never
 * be repeated by an automatic retry or a worker restart. A task reports the
 * moment it commits such an effect, and from then on the execution is never
 * re-run — see `executions.effect_committed_at`.
 *
 * A task subprocess reports it by writing this marker at the start of a line
 * on stdout or stderr, *before* the action that commits the effect: reporting
 * too early only costs an automatic retry, reporting too late can cost a
 * duplicate post. In-process tasks call `context.commitEffect()` instead.
 */
export const EFFECT_COMMITTED_MARKER = '[phone-farm] effect-committed';

/** The message recorded on an execution that was refused a re-run. */
export const EFFECT_COMMITTED_REFUSAL = 'Not re-run: the task already committed its side effect (e.g. the post was submitted)';

export function isEffectCommittedLine(line: string): boolean {
    return line.trimStart().startsWith(EFFECT_COMMITTED_MARKER);
}

/**
 * For task subprocesses: print the marker and wait until it has been handed to
 * the pipe, then commit the effect. (Pipe writes are asynchronous on macOS.)
 */
export function reportEffectCommitted(description: string, stream: NodeJS.WritableStream = process.stdout): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.write(`${EFFECT_COMMITTED_MARKER} ${description}\n`, (error) => (error ? reject(error) : resolve()));
    });
}
