import { fileURLToPath } from 'node:url'

import { format, resolveConfig } from 'prettier'

const config = (await resolveConfig(fileURLToPath(new URL('../package.json', import.meta.url)))) ?? {}

export function formatGeneratedTypeScript(source: string): Promise<string> {
  return format(source, { ...config, parser: 'typescript' })
}
