import type { SkipEntry } from './skip-manifest.ts'

/**
 * Official-suite cases the analyzer conformance test does not assert, each with a
 * reason. The remaining entries are valid cases the analyzer flags on purpose
 * (deliberate strictness the suite does not share).
 * The hygiene test fails if an entry stops matching, so stale entries cannot
 * linger — and a fixed check makes its entries fail, forcing their removal.
 */
export const ANALYZER_SKIP_MANIFEST: SkipEntry[] = [
  // --- deliberate strictness: the analyzer flags these valid cases on purpose ---
  {
    suite: 'r4',
    group: 'testIif',
    test: 'testIif3',
    reason:
      'singleton misuse inside a lazily-untaken iif() branch: the branch never runs here, but evaluating it would error, and a static checker reads all branches',
  },
  {
    suite: 'r5',
    group: 'testIif',
    test: 'testIif3',
    reason:
      'singleton misuse inside a lazily-untaken iif() branch: the branch never runs here, but evaluating it would error, and a static checker reads all branches',
  },
  {
    suite: 'r4',
    group: 'testIif',
    test: 'testIif4',
    reason:
      'singleton misuse inside a lazily-untaken iif() branch: the branch never runs here, but evaluating it would error, and a static checker reads all branches',
  },
  {
    suite: 'r5',
    group: 'testIif',
    test: 'testIif4',
    reason:
      'singleton misuse inside a lazily-untaken iif() branch: the branch never runs here, but evaluating it would error, and a static checker reads all branches',
  },
  {
    suite: 'r4',
    group: 'testType',
    test: 'testType22',
    reason:
      "the suite evaluates is(System.Patient) to false at runtime; statically, naming a type that doesn't exist is exactly what unknown-type is for",
  },
  {
    suite: 'r5',
    group: 'testType',
    test: 'testType22',
    reason:
      "the suite evaluates is(System.Patient) to false at runtime; statically, naming a type that doesn't exist is exactly what unknown-type is for",
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'defineVariable13',
    reason:
      "typed defineVariable() bindings surface that %n2.given may hold several items, so '+' gets a singleton diagnostic; the fixture happens to hold one given (spec §11 strictness)",
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'defineVariable14',
    reason:
      "typed defineVariable() bindings surface that %n2.given may hold several items, so '+' gets a singleton diagnostic; the fixture happens to hold one given (spec §11 strictness)",
  },
]
