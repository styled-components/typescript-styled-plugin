/**
 * Pure helpers for test/performance/scaling-check.ts's CLI entry point, kept in their own module so
 * they are importable without triggering that file's own `main()` (scaling-check.ts runs its whole
 * check suite as a side effect of being the process entry point, which a test importing it directly
 * would trigger too).
 */

const FILTER_FLAG = '--filter'

/**
 * The value after `--filter` in `argv` (already without the `node`/script arguments), or undefined
 * when the flag is absent. Throws when the flag is given with no value following it.
 */
export function parseFilterArgument(argv: readonly string[]): string | undefined {
  const flagIndex = argv.indexOf(FILTER_FLAG)
  if (flagIndex === -1) {
    return undefined
  }
  const value = argv[flagIndex + 1]
  if (value === undefined) {
    throw new Error(
      `${FILTER_FLAG} needs a value: \`corepack yarn test:scaling ${FILTER_FLAG} <substring>\`.`,
    )
  }
  return value
}

export interface NamedCheck {
  readonly name: string
}

export interface SelectedCheck<Check extends NamedCheck> {
  readonly check: Check
  /** The check's position in `allChecks`, unchanged by filtering: a worker loads the same full list and looks the check up by this index. */
  readonly index: number
}

/**
 * Every check whose name includes `filter` (a plain substring match, not a pattern), paired with
 * its original index into `allChecks`. Every check, in order, when `filter` is undefined. Throws
 * loudly when a filter is given but matches nothing, rather than silently running zero checks and
 * exiting 0.
 */
export function selectChecks<Check extends NamedCheck>(
  allChecks: readonly Check[],
  filter: string | undefined,
): readonly SelectedCheck<Check>[] {
  const indexed = allChecks.map((check, index) => ({ check, index }))
  if (filter === undefined) {
    return indexed
  }
  const matched = indexed.filter(({ check }) => check.name.includes(filter))
  if (matched.length === 0) {
    throw new Error(
      `${FILTER_FLAG} "${filter}" matched no scaling check. Available checks:\n` +
        allChecks.map((check) => `  ${check.name}`).join('\n'),
    )
  }
  return matched
}

interface StageProgress {
  readonly stage: string
}

interface LineProgress {
  readonly line: string
}

export type StageOrLineProgress = LineProgress | StageProgress

export interface ProgressLocationTracker {
  /** Where the check last reported being, as a trailing clause ("at size 24000, run 2 of 5, attempt 1 of 3", or "before its first sample" when no stage report has arrived yet). */
  location(): string
  /** Feed every progress report from a check's worker, in order. */
  onProgress(progress: StageOrLineProgress): void
}

const NO_SAMPLE_LOCATION = 'before its first sample'

/**
 * Remembers the most recent "stage" progress report across a run, so a later free-form "line"
 * report (scaling-check.ts's retry message, printed between timing attempts) does not erase it: a
 * retry line only ever appears after real sampling has already happened, so the run's last known
 * location should still name that sampling, never claim work never started.
 */
export function createProgressLocationTracker(): ProgressLocationTracker {
  let lastStage: string | undefined
  return {
    location: () => (lastStage === undefined ? NO_SAMPLE_LOCATION : `at ${lastStage}`),
    onProgress(progress) {
      if ('stage' in progress) {
        lastStage = progress.stage
      }
    },
  }
}
