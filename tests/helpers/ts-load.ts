/**
 * Loading the app's own modules from the test runner.
 *
 * The test runner executes TypeScript directly (`node --experimental-strip-types`),
 * but route handlers import through the `@/…` alias and pull in `@/lib/db`,
 * which constructs a PrismaClient at import time. Neither resolves here: the
 * runner has no tsconfig `paths`, and there is no database in CI.
 *
 * So each module is transpiled to CommonJS and evaluated with a `require` shim
 * that:
 *
 *   1. returns a stub when one is registered for that specifier or for the
 *      file it resolves to,
 *   2. otherwise resolves `@/x` and `./x` to the real TypeScript file and loads
 *      it through the same shim, so the *real* implementation is exercised,
 *   3. otherwise defers to Node.
 *
 * That is what lets a test drive the genuine route handler and the genuine
 * LivePay signature verifier while swapping only the database and the
 * socket-level fetch.
 */

import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export type StubMap = Record<string, any>

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
}

function transpile(file: string): string {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: COMPILER_OPTIONS }).outputText
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string | null = null
  if (spec.startsWith('@/')) base = path.resolve(REPO_ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  if (!base) return null

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Load a TypeScript module from the repository with the given import stubs.
 *
 * `stubs` keys may be import specifiers (`'@/lib/db'`, `'./db'`) or absolute
 * file paths; a path key stubs every importer of that file.
 *
 * Modules are cached per stub-map identity, so a test that reuses one stubs
 * object shares module state (and gets the same fake database) while a test
 * that builds a fresh stubs object starts clean.
 */
export function loadTsModule<T = any>(relPath: string, stubs: StubMap = {}): T {
  const entry = path.isAbsolute(relPath) ? relPath : path.resolve(REPO_ROOT, relPath)

  const cache: Map<string, any> = (stubs as any).__loaderCache ?? new Map()
  Object.defineProperty(stubs, '__loaderCache', {
    value: cache,
    enumerable: false,
    configurable: true,
    writable: true,
  })

  function load(file: string): any {
    if (cache.has(file)) return cache.get(file)

    const mod = new Module(file)
    mod.filename = file
    mod.paths = Module._nodeModulePaths(path.dirname(file))
    cache.set(file, mod.exports)

    const originalRequire = mod.require.bind(mod)
    const shim = (spec: string) => {
      if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec]

      const target = resolveLocal(file, spec)
      if (target && Object.prototype.hasOwnProperty.call(stubs, target)) return stubs[target]
      if (target) return load(target)

      return originalRequire(spec)
    }

    ;(mod as any).require = shim
    ;(mod as any)._compile(transpile(file), file)
    cache.set(file, mod.exports)
    return mod.exports
  }

  return load(entry)
}

/** Absolute path of an in-repo source file, for path-keyed stubs. */
export function srcPath(relPath: string): string {
  return path.resolve(REPO_ROOT, 'src', relPath)
}
