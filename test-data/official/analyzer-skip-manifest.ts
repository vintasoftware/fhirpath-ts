import type { SkipEntry } from './skip-manifest.ts'

/**
 * Official-suite cases the analyzer conformance test does not assert, each with a
 * reason. Two kinds live here: cases the analyzer should flag but cannot yet
 * (missing checks — every entry names the follow-up), and valid cases the
 * analyzer flags on purpose (deliberate strictness the suite does not share).
 * The hygiene test fails if an entry stops matching, so stale entries cannot
 * linger — and a fixed check makes its entries fail, forcing their removal.
 */
export const ANALYZER_SKIP_MANIFEST: SkipEntry[] = [
  // --- missing checks: the analyzer emits no diagnostic yet ---
  {
    suite: 'r4',
    group: 'testDollar',
    test: 'testDollarOrderNotAllowed',
    reason: 'flagging skip() after unordered children() needs ORDERED/UNORDERED collection tracking, which the analyzer does not do',
  },
  {
    suite: 'r5',
    group: 'testDollar',
    test: 'testDollarOrderNotAllowed',
    reason: 'flagging skip() after unordered children() needs ORDERED/UNORDERED collection tracking, which the analyzer does not do',
  },
  {
    suite: 'r4',
    group: 'testCollectionBoolean',
    test: 'testCollectionBoolean1',
    reason: 'the iif() criterion is not yet checked for cardinality',
  },
  {
    suite: 'r5',
    group: 'testCollectionBoolean',
    test: 'testCollectionBoolean1',
    reason: 'the iif() criterion is not yet checked for cardinality',
  },
  // r4 testIif6 needs no entry: its runtime skip (R5 revised the semantics) already excludes it here.
  {
    suite: 'r5',
    group: 'testIif',
    test: 'testIif6',
    reason: 'the iif() criterion is not yet checked for Boolean-ness',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'defineVariable9',
    reason: 'defineVariable() scope and redefinition are not yet tracked statically',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'defineVariable10',
    reason: 'defineVariable() scope and redefinition are not yet tracked statically',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'dvRedefiningVariableThrowsError',
    reason: 'defineVariable() scope and redefinition are not yet tracked statically',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'defineVariable16',
    reason: 'defineVariable() scope and redefinition are not yet tracked statically',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'dvCantOverwriteSystemVar',
    reason: 'defineVariable() scope and redefinition are not yet tracked statically',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'dvUsageOutsideScopeThrows',
    reason: 'defineVariable() scope and redefinition are not yet tracked statically',
  },

  // --- false positives on valid cases: fixes tracked in WS2 ---
  {
    suite: 'r4',
    group: 'testLiterals',
    test: 'testIntegerBooleanNotTrue',
    reason: "not() demands a Boolean input, but Integer 0/1 convert implicitly (WS2: relax not()'s input kind)",
  },
  {
    suite: 'r5',
    group: 'testLiterals',
    test: 'testIntegerBooleanNotTrue',
    reason: "not() demands a Boolean input, but Integer 0/1 convert implicitly (WS2: relax not()'s input kind)",
  },
  {
    suite: 'r4',
    group: 'testLiterals',
    test: 'testIntegerBooleanNotFalse',
    reason: "not() demands a Boolean input, but Integer 0/1 convert implicitly (WS2: relax not()'s input kind)",
  },
  {
    suite: 'r5',
    group: 'testLiterals',
    test: 'testIntegerBooleanNotFalse',
    reason: "not() demands a Boolean input, but Integer 0/1 convert implicitly (WS2: relax not()'s input kind)",
  },
  {
    suite: 'r4',
    group: 'testQuantity',
    test: 'testQuantity10',
    reason: "Quantity / Quantity is statically typed Decimal, so '= Quantity' looks incomparable (WS2: fix '/')",
  },
  {
    suite: 'r5',
    group: 'testQuantity',
    test: 'testQuantity10',
    reason: "Quantity / Quantity is statically typed Decimal, so '= Quantity' looks incomparable (WS2: fix '/')",
  },
  {
    suite: 'r4',
    group: 'testQuantity',
    test: 'testQuantity11',
    reason: "Quantity / Quantity is statically typed Decimal, so '= Quantity' looks incomparable (WS2: fix '/')",
  },
  {
    suite: 'r5',
    group: 'testQuantity',
    test: 'testQuantity11',
    reason: "Quantity / Quantity is statically typed Decimal, so '= Quantity' looks incomparable (WS2: fix '/')",
  },
  {
    suite: 'r4',
    group: 'testIif',
    test: 'testIif3',
    reason: 'singleton misuse inside a lazily-untaken iif() branch; becomes a warning with WS2 severity work',
  },
  {
    suite: 'r5',
    group: 'testIif',
    test: 'testIif3',
    reason: 'singleton misuse inside a lazily-untaken iif() branch; becomes a warning with WS2 severity work',
  },
  {
    suite: 'r4',
    group: 'testIif',
    test: 'testIif4',
    reason: 'singleton misuse inside a lazily-untaken iif() branch; becomes a warning with WS2 severity work',
  },
  {
    suite: 'r5',
    group: 'testIif',
    test: 'testIif4',
    reason: 'singleton misuse inside a lazily-untaken iif() branch; becomes a warning with WS2 severity work',
  },
  {
    suite: 'r4',
    group: 'testSort',
    test: 'testSort8',
    reason: "sort() marks descending keys with unary '-' on any type; the analyzer only knows numeric negation (WS2)",
  },
  {
    suite: 'r5',
    group: 'testSort',
    test: 'testSort8',
    reason: "sort() marks descending keys with unary '-' on any type; the analyzer only knows numeric negation (WS2)",
  },
  {
    suite: 'r4',
    group: 'testSort',
    test: 'testSort10',
    reason: "sort() marks descending keys with unary '-' on any type; the analyzer only knows numeric negation (WS2)",
  },
  {
    suite: 'r5',
    group: 'testSort',
    test: 'testSort10',
    reason: "sort() marks descending keys with unary '-' on any type; the analyzer only knows numeric negation (WS2)",
  },

  // --- deliberate strictness: the analyzer flags these on purpose ---
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
]
