/**
 * Official-suite cases this engine does not run, each with a reason. The harness
 * fails if an entry matches nothing, so stale entries cannot linger.
 */
export interface SkipEntry {
  suite: 'r4' | 'r5'
  /** Group name, exact. */
  group?: string
  /** Test name, exact. */
  test?: string
  /** Test mode attribute, exact — skips every test carrying it. */
  mode?: string
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

export const SKIP_MANIFEST: SkipEntry[] = [
  {
    suite: 'r5',
    mode: 'cda',
    reason: 'CDA documents need a CDA ModelInfo; out of scope for v1 (README: deferred features)',
  },
  {
    suite: 'r5',
    mode: 'tx',
    reason: 'terminology tests need a terminology service; out of scope for v1 (README: deferred features)',
  },
  {
    suite: 'r5',
    mode: 'html',
    reason: 'the parameters-example-html fixture is only distributed as XML; htmlChecks() is covered by unit tests',
  },
  {
    suite: 'r5',
    mode: 'lenient/polymorphics',
    reason: 'lenient polymorphic access is profile-dependent behavior this engine does not offer',
  },
  {
    suite: 'r4',
    group: 'testIif',
    test: 'testIif6',
    reason:
      'R4 expected a semantic error for a non-boolean iif criterion; R5 revised this to the singleton rule, which this engine follows',
  },
  {
    suite: 'r5',
    group: 'miscEngineTests',
    test: 'testMultipleResolve',
    reason: 'uses the R5-only DiagnosticReport.composition element; this package ships the R4 model',
  },
  {
    suite: 'r4',
    group: 'LowBoundary',
    test: 'LowBoundaryDecimal15',
    reason: 'suite expects -0.0, but the mathematical lower bound floored at precision 1 is -0.1',
  },
  {
    suite: 'r5',
    group: 'LowBoundary',
    test: 'LowBoundaryDecimal15',
    reason: 'suite expects -0.0, but the mathematical lower bound floored at precision 1 is -0.1',
  },
  {
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal15',
    reason: 'suite expects 0.0, but the mathematical upper bound ceiled at precision 1 is 0.1',
  },
  {
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal15',
    reason: 'suite expects 0.0, but the mathematical upper bound ceiled at precision 1 is 0.1',
  },
  {
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal16',
    reason:
      'the expression -0.0034.highBoundary(1) negates the boundary of 0.0034 by precedence; the suite expects 0.0',
  },
  {
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDecimal16',
    reason:
      'the expression -0.0034.highBoundary(1) negates the boundary of 0.0034 by precedence; the suite expects 0.0',
  },
  {
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond1',
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond1',
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    suite: 'r4',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond3',
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    suite: 'r5',
    group: 'HighBoundary',
    test: 'HighBoundaryDateTimeMillisecond3',
    reason:
      'suite fills minutes with 00 in a high boundary (T08:00:59.999); the latest moment of hour 08 is T08:59:59.999',
  },
  {
    suite: 'r5',
    group: 'defineVariable',
    test: 'dvConceptMapExample',
    reason: 'uses the R5-only ConceptMap ... target.relationship element; this package ships the R4 model',
  },
  {
    suite: 'r4',
    group: 'testPlus',
    test: 'testPlusDate19',
    reason:
      'R4 expected fractional seconds to truncate; R5 revised them to add as milliseconds, which this engine follows',
  },
]
