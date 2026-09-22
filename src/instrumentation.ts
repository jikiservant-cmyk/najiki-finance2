/**
 * Next.js instrumentation hook.
 *
 * `register()` runs once per server process, before the first request is
 * handled. This is where we assert that the production environment is fully
 * configured — previously `assertRuntimeEnv()` existed in src/lib/env.ts but
 * was never imported by anything, so the validation never ran and the app
 * would boot happily with a broken/missing security configuration.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  const { assertRuntimeEnv } = await import('@/lib/env')
  assertRuntimeEnv()
}
