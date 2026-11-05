// All data in this file is synthetic.
import { describe, expect, it } from 'vitest'

import { compile } from './api/compile.ts'
import { FhirPathRuntimeError, FhirPathSyntaxError, ProjectionRowError, safeErrorMessage } from './errors.ts'
import { r4 } from './r4/index.ts'

/** What `run` throws. */
function caught(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('Expected an error')
}

describe('safeErrorMessage', () => {
  it("gives an engine error's own message", () => {
    const syntax = caught(() => compile('name.('))
    expect(syntax).toBeInstanceOf(FhirPathSyntaxError)
    expect(safeErrorMessage(syntax)).toBe("Expected an element or function name after '.', got '(' (line 1, column 6)")
    const runtime = caught(() => r4.evaluate('(1 | 2).single()'))
    expect(runtime).toBeInstanceOf(FhirPathRuntimeError)
    expect(safeErrorMessage(runtime)).toBe((runtime as Error).message)
  })

  it("gives a row error's message, without its cause", () => {
    const error = new ProjectionRowError(new Error('Alex Example'), {
      index: 2,
      total: 3,
      column: 'name',
      subject: {},
    })
    expect(safeErrorMessage(error)).toBe("project(): row 2 failed in column 'name'")
  })

  it('gives only the name of another error, whose text can carry data', () => {
    const functions = {
      findPerson: {
        fn: () => {
          throw new TypeError('no patient Alex Example')
        },
      },
    }
    expect(safeErrorMessage(caught(() => r4.evaluate('findPerson()', {}, { functions })))).toBe('Unexpected TypeError')
    expect(safeErrorMessage(new Error('Alex Example'))).toBe('Unexpected Error')
    expect(safeErrorMessage('Alex Example')).toBe('Unexpected error')
    expect(safeErrorMessage(undefined)).toBe('Unexpected error')
  })
})
