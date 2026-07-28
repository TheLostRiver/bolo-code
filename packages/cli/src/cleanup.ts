export type CleanupStep = () => void
export type AsyncCleanupStep = () => void | Promise<void>

export function runCleanupSteps(steps: readonly CleanupStep[]): void {
  let firstError: unknown
  let failed = false
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      if (!failed) {
        failed = true
        firstError = error
      }
    }
  }
  if (failed) throw firstError
}

export async function runAsyncCleanupSteps(
  steps: readonly AsyncCleanupStep[],
): Promise<void> {
  let firstError: unknown
  let failed = false
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      if (!failed) {
        failed = true
        firstError = error
      }
    }
  }
  if (failed) throw firstError
}
