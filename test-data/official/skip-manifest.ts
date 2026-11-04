/**
 * Official-suite cases this engine does not run, each with a reason. The harness
 * fails if an entry matches nothing, so stale entries cannot linger.
 */
/**
 * Why a case does not run: another FHIR version or model (R5, STU3, DSTU2,
 * CDA), a documented divergence from the suite (quirk), a feature the README
 * defers, or a function that neither FHIRPath nor FHIR defines (extension).
 */
export type SkipCategory = 'model' | 'quirk' | 'deferred' | 'extension'

/** How skipped test titles name each category, in both the official suites and the corpora. */
export const SKIP_CATEGORY_LABELS: Readonly<Record<SkipCategory, string>> = {
  model: 'different FHIR version or model',
  quirk: 'intentional divergence',
  deferred: 'deferred feature',
  extension: 'outside FHIRPath and FHIR',
}

export interface SkipEntry {
  suite: 'r4' | 'r5'
  category: SkipCategory
  /** Group name, exact. */
  group?: string
  /** Test name, exact. */
  test?: string
  /** Test mode attribute, exact — skips every test carrying it. */
  mode?: string
  /**
   * The skip disputes the suite's expected value, not a feature. The analyzer
   * conformance test does not read values, so it still runs the case, and the
   * hygiene test fails when the engine starts returning the expected value.
   */
  runtimeOnly?: true
  reason: string
}

/** The pipeline phase an official `invalid` tag maps to (HAPI's parse/check/evaluate split). */
export type PhaseName = 'syntax' | 'semantic' | 'execution'

/**
 * Cases where this engine fails at a different phase than the suite's `invalid`
 * tag says, each with the reason the divergence is deliberate. The hygiene test
 * fails if an entry stops matching an invalid case.
 */
export interface PhaseOverride {
  suite: 'r4' | 'r5'
  group: string
  test: string
  /** The phase whose error class this engine actually raises. */
  throws: PhaseName
  reason: string
}

export const PHASE_OVERRIDES: PhaseOverride[] = [
  {
    suite: 'r4',
    group: 'testLiterals',
    test: 'testLiteralTimeUTC',
    throws: 'syntax',
    reason:
      'the FHIRPath grammar gives TIME literals no timezone offset, so @T14:34:28Z is rejected at parse; the suite tags it execution',
  },
  {
    suite: 'r5',
    group: 'testLiterals',
    test: 'testLiteralTimeUTC',
    throws: 'syntax',
    reason:
      'the FHIRPath grammar gives TIME literals no timezone offset, so @T14:34:28Z is rejected at parse; the suite tags it execution',
  },
  {
    suite: 'r4',
    group: 'testLiterals',
    test: 'testLiteralTimeTimezoneOffset',
    throws: 'syntax',
    reason:
      'the FHIRPath grammar gives TIME literals no timezone offset, so @T14:34:28+10:00 is rejected at parse; the suite tags it execution',
  },
  {
    suite: 'r5',
    group: 'testLiterals',
    test: 'testLiteralTimeTimezoneOffset',
    throws: 'syntax',
    reason:
      'the FHIRPath grammar gives TIME literals no timezone offset, so @T14:34:28+10:00 is rejected at parse; the suite tags it execution',
  },
]

/** One entry per suite and `[group, test]` case, all with the same category and reason. */
function skipCases(
  suites: readonly SkipEntry['suite'][],
  cases: readonly (readonly [group: string, test?: string])[],
  skip: Pick<SkipEntry, 'category' | 'reason' | 'runtimeOnly'>
): SkipEntry[] {
  return suites.flatMap(suite =>
    cases.map(([group, test]) => ({ ...skip, suite, group, ...(test !== undefined && { test }) }))
  )
}

const BOTH_SUITES = ['r4', 'r5'] as const

export const SKIP_MANIFEST: SkipEntry[] = [
  ...skipCases(BOTH_SUITES, [['documentFunctions']], {
    category: 'extension',
    reason:
      'section(), entry(), entryIn(), resources(), resourcesIn(), sameSubject(), and hasCoding() extend the HL7 Java engine (org.hl7.fhir.core); FHIRPath and FHIR do not define them',
  }),
  ...skipCases(BOTH_SUITES, [['testLiterals', 'testLiteralUnicodeInvalid']], {
    category: 'quirk',
    reason:
      "suite rejects '\\u+041' as a syntax error; FHIRPath 3.0.0 (\"String\") drops a backslash that starts no escape, as in '\\u005' giving 'u005'",
  }),
  ...skipCases(
    BOTH_SUITES,
    [
      ['testLessThan', 'testLessThan29'],
      ['testGreaterThan', 'testGreaterThan29'],
    ],
    {
      category: 'quirk',
      runtimeOnly: true,
      reason:
        "suite expects empty for 1 year against 2 months; FHIRPath 3.0.0 (\"Comparison\") converts calendar years and months to each other: '6 months > 1 year' is false",
    }
  ),
  ...skipCases(
    BOTH_SUITES,
    [
      ['LowBoundary', 'LowBoundaryDecimalExponent1'],
      ['LowBoundary', 'LowBoundaryDecimalExponent3'],
      ['LowBoundary', 'LowBoundaryDecimalExponent4'],
      ['HighBoundary', 'HighBoundaryDecimalExponent1'],
      ['HighBoundary', 'HighBoundaryDecimalExponent2'],
      ['HighBoundary', 'HighBoundaryDecimalExponent4'],
      ['HighBoundary', 'HighBoundaryDecimalExponent5'],
    ],
    {
      category: 'quirk',
      runtimeOnly: true,
      reason:
        'suite reads the precision of 9.5e2 from its mantissa (to the tens); a decimal keeps its precision as digits after the point, so 9.5e2 is 950, precise to the unit',
    }
  ),
  ...skipCases(
    ['r5'],
    ['testDistinct30', 'testDistinct32', 'testDistinct33', 'testDistinct34', 'testDistinct35'].map(
      test => ['testDistinct', test] as const
    ),
    {
      category: 'quirk',
      runtimeOnly: true,
      reason:
        'suite keeps the last of each repeated value; FHIRPath 3.0.0 leaves the order of distinct() open, and this engine keeps the first, as union() does',
    }
  ),
  ...skipCases(
    ['r5'],
    [
      ['testDistinct', 'testDistinct29'],
      ['testDistinct', 'testDistinct36'],
    ],
    {
      category: 'quirk',
      runtimeOnly: true,
      reason:
        'suite expects empty when dates of different precision meet; FHIRPath 3.0.0 counts items as distinct unless = returns true, and @2020 = @2020-01-01 is empty',
    }
  ),
  {
    category: 'model',
    suite: 'r5',
    mode: 'cda',
    reason: 'CDA documents need a CDA model; this package ships the FHIR R4 model',
  },
  {
    category: 'quirk',
    suite: 'r5',
    mode: 'lenient/polymorphics',
    reason:
      'FHIRPath reads a choice element by its base name; the suite itself pins suffixed keys such as valueQuantity as errors outside lenient mode (testPolymorphismB)',
  },
  {
    category: 'model',
    suite: 'r5',
    group: 'miscEngineTests',
    test: 'testMultipleResolve',
    reason: 'uses the R5-only DiagnosticReport.composition element; this package ships the R4 model',
  },
  {
    category: 'quirk',
    suite: 'r4',
    group: 'LowBoundary',
    test: 'LowBoundaryDecimal15',
    runtimeOnly: true,
    reason: 'suite expects -0.0, but the mathematical lower bound floored at precision 1 is -0.1',
  },
  {
    category: 'quirk',
    suite: 'r5',
    group: 'LowBoundary',
    test: 'LowBoundaryDecimal15',
    runtimeOnly: true,
    reason: 'suite expects -0.0, but the mathematical lower bound floored at precision 1 is -0.1',
  },
  {
    category: 'quirk',
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal15',
    runtimeOnly: true,
    reason: 'suite expects 0.0, but the mathematical upper bound ceiled at precision 1 is 0.1',
  },
  {
    category: 'quirk',
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal15',
    runtimeOnly: true,
    reason: 'suite expects 0.0, but the mathematical upper bound ceiled at precision 1 is 0.1',
  },
  {
    category: 'quirk',
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal16',
    runtimeOnly: true,
    reason:
      'the expression -0.0034.highBoundary(1) negates the boundary of 0.0034 by precedence; the suite expects 0.0',
  },
  {
    category: 'quirk',
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal16',
    runtimeOnly: true,
    reason:
      'the expression -0.0034.highBoundary(1) negates the boundary of 0.0034 by precedence; the suite expects 0.0',
  },
  {
    category: 'quirk',
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond1',
    runtimeOnly: true,
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    category: 'quirk',
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond1',
    runtimeOnly: true,
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    category: 'quirk',
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond3',
    runtimeOnly: true,
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    category: 'quirk',
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond3',
    runtimeOnly: true,
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    category: 'model',
    suite: 'r5',
    group: 'defineVariable',
    test: 'dvConceptMapExample',
    reason: 'uses the R5-only ConceptMap ... target.relationship element; this package ships the R4 model',
  },
  {
    category: 'model',
    suite: 'r4',
    group: 'testPlus',
    test: 'testPlusDate19',
    runtimeOnly: true,
    reason:
      'R4 expected fractional seconds to truncate; R5 revised them to add as milliseconds, which this engine follows',
  },
  {
    category: 'quirk',
    suite: 'r4',
    group: 'testSort',
    test: 'testSort10',
    runtimeOnly: true,
    reason:
      "suite sorts the name without a family first under -family; FHIRPath 3.0.0 makes an empty key lower than every value, so it sorts last descending and the first name is 'maiden'",
  },
  {
    category: 'quirk',
    suite: 'r5',
    group: 'testSort',
    test: 'testSort10',
    runtimeOnly: true,
    reason:
      "suite sorts the name without a family first under -family; FHIRPath 3.0.0 makes an empty key lower than every value, so it sorts last descending and the first name is 'maiden'",
  },
]
