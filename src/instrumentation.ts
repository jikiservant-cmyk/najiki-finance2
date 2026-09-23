/**
 * Next.js instrumentation hook.
 *
 * `register()` runs once per server process, before the first request is
 * handled. Two things happen here:
 *
 *  1. The production environment is asserted to be fully configured —
 *     previously `assertRuntimeEnv()` existed in src/lib/env.ts but was never
 *     imported by anything, so the validation never ran and the app booted
 *     happily with a broken security configuration.
 *
 *  2. Process-level handlers for `unhandledRejection` and `uncaughtException`
 *     are installed, so a leaked promise is *reported* rather than appearing as
 *     an anonymous `⨯ unhandledRejection` line in the platform's log — which is
 *     exactly what this app was doing, with no way to tell which code path was
 *     responsible.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

let _handlersInstalled = false

function installProcessSafetyNets(): void {
  if (_handlersInstalled) return
  _handlersInstalled = true

  process.on('unhandledRejection', (reason) => {
    // Logged with full context and then left alone: a rejected promise nobody
    // awaited is a defect to fix, but killing a request-serving process over
    // one would turn a bug into an outage. Alerting should watch for this line.
    const detail =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
        : String(reason)

    console.error(
      '[FATAL-GUARD] Unhandled promise rejection. This is a defect — a promise ' +
        'was rejected with no handler. Fix it; this log is how you find it.',
      detail
    )
  })

  process.on('uncaughtException', (error) => {
    // Different case: an uncaught exception means the process may be in an
    // unknown state, and continuing to serve money-moving requests from it is
    // not acceptable. Log, then exit so the platform restarts cleanly.
    console.error(
      '[FATAL-GUARD] Uncaught exception — exiting so the process restarts clean.',
      error?.stack || error
    )

    // Give the log a moment to flush before the process goes away.
    setTimeout(() => process.exit(1), 100).unref?.()
  })
}

export async function register() {
  installProcessSafetyNets()

  const { assertRuntimeEnv } = await import('@/lib/env')
  assertRuntimeEnv()
}
