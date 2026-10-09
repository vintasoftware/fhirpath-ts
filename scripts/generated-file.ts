import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type GeneratedPath = string | URL

interface GeneratedFileOptions {
  check: boolean
  regenerate: string
  summary?: string
}

export function writeOrCheckGenerated(path: GeneratedPath, content: string, options: GeneratedFileOptions): void {
  const displayPath = typeof path === 'string' ? path : fileURLToPath(path)
  if (options.check) {
    if (readFileSync(path, 'utf8') !== content) {
      console.error(`${displayPath} is stale; run ${options.regenerate}`)
      process.exitCode = 1
    }
    return
  }
  writeFileSync(path, content)
  console.log(`wrote ${displayPath}${options.summary === undefined ? '' : ` (${options.summary})`}`)
}
