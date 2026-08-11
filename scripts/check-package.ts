import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageManifest {
  bin?: string | Record<string, string>
  exports?: Record<string, unknown>
  publishConfig?: { exports?: Record<string, unknown> }
}

function assertString(value: unknown, message: string): asserts value is string {
  assert.equal(typeof value, 'string', message)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const fixturesDirectory = join(root, 'scripts', 'package-check-fixtures')
const rawArguments = process.argv.slice(2)
const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--output')) {
  throw new Error('usage: pnpm check:package [-- --output <tarball>]')
}
const output = arguments_[1] === undefined ? undefined : resolve(arguments_[1])
const temporaryRoot = mkdtempSync(join(tmpdir(), 'fhirpath-ts-package-'))
const packDirectory = join(temporaryRoot, 'pack')
const consumerDirectory = join(temporaryRoot, 'consumer')

// pnpm exposes its settings to lifecycle scripts as npm_config_* variables.
// npm 11 warns about pnpm-only names, so the temporary local install gets a
// clean environment and reads any standard npm configuration from files. The
// real publish runs outside this script and retains its OIDC environment.
const npmEnvironment: NodeJS.ProcessEnv = {}
for (const [key, value] of Object.entries(process.env)) {
  if (!key.toLowerCase().startsWith('npm_config_')) {
    npmEnvironment[key] = value
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function packageBin(packageName: string, command: string): string {
  const packageDirectory = join(root, 'node_modules', packageName)
  const { bin } = readJson<PackageManifest>(join(packageDirectory, 'package.json'))
  const relativePath = typeof bin === 'string' ? bin : bin?.[command]
  assertString(relativePath, `${packageName} does not declare the ${command} bin`)
  return resolve(packageDirectory, relativePath)
}

const tools = {
  npm: packageBin('npm', 'npm'),
  publint: packageBin('publint', 'publint'),
  attw: packageBin('@arethetypeswrong/cli', 'attw'),
  tsc: packageBin('typescript', 'tsc'),
}

type ToolName = keyof typeof tools

function runTool(name: ToolName, args: string[], cwd = root, environment: NodeJS.ProcessEnv = process.env): void {
  execFileSync(process.execPath, [tools[name], ...args], { cwd, env: environment, stdio: 'inherit' })
}

function packWithPnpm(args: string[]): string {
  const executable = process.env['npm_execpath']
  assertString(executable, 'run this check through pnpm')
  const isJavaScript = /\.(?:cjs|mjs|js)$/i.test(executable)
  const command = isJavaScript ? process.execPath : executable
  const commandArguments = isJavaScript ? [executable, ...args] : args
  const result = spawnSync(command, commandArguments, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error !== undefined) {
    throw result.error
  }
  assert.equal(result.status, 0, `pnpm pack exited with status ${result.status}`)
  return result.stdout
}

function linkPeer(name: string): void {
  const source = join(root, 'node_modules', name)
  if (!existsSync(source)) {
    throw new Error(`Missing ${name}; run pnpm install before pnpm check:package`)
  }
  symlinkSync(source, join(consumerDirectory, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  const executable = join(
    consumerDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'fhirpath-check.cmd' : 'fhirpath-check'
  )
  return spawnSync(executable, args, {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

try {
  if (!existsSync(join(root, 'dist', 'index.js'))) {
    throw new Error('Missing dist; run pnpm build before pnpm check:package')
  }

  const manifest = readJson<PackageManifest>(join(root, 'package.json'))
  assert(manifest.exports, 'package.json must declare exports')
  assert(manifest.publishConfig?.exports, 'publishConfig must declare the published exports')
  assert.deepEqual(
    Object.keys(manifest.publishConfig.exports).sort(),
    Object.keys(manifest.exports).sort(),
    'source and published exports must expose the same entry points'
  )

  mkdirSync(packDirectory)
  mkdirSync(consumerDirectory)
  for (const fixture of readdirSync(fixturesDirectory)) {
    copyFileSync(join(fixturesDirectory, fixture), join(consumerDirectory, fixture))
  }

  const packOutput = packWithPnpm([
    'pack',
    '--config.ignore-scripts=true',
    '--json',
    '--pack-destination',
    packDirectory,
  ])
  const { filename, files } = JSON.parse(packOutput) as {
    filename?: unknown
    files?: { path?: unknown }[]
  }
  assertString(filename, 'pnpm pack did not report a tarball filename')
  assert(Array.isArray(files), 'pnpm pack did not report the packed files')
  const packedPaths = new Set(files.flatMap(file => (typeof file.path === 'string' ? [file.path] : [])))
  const verificationArtifacts = [
    'typed/capability-registry.',
    'typed/perf-fixture.types.',
    'typed/generated/capabilities.',
    'typed/generated/capability-assertions.types.',
    'typed/generated/corpus-audit.',
    'typed/generated/full-language-perf.types.',
    'typed/generated/function-capabilities.',
    'typed/generated/metadata.',
    'typed/generated/precision-report.',
  ]
  const leakedArtifacts = [...packedPaths].filter(path =>
    verificationArtifacts.some(artifact => path.includes(artifact))
  )
  assert.deepEqual(leakedArtifacts, [], `verification artifacts leaked into the package: ${leakedArtifacts.join(', ')}`)
  assert(packedPaths.has('src/typed/generated/metadata-compact.ts'), 'the source type metadata is missing')
  assert(packedPaths.has('dist/typed/generated/metadata-compact.d.ts'), 'the built type metadata is missing')
  const tarball = resolve(packDirectory, filename)

  runTool('publint', ['run', tarball, '--strict', '--pack=false'])
  runTool('attw', [tarball, '--profile', 'esm-only'])
  runTool(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    consumerDirectory,
    npmEnvironment
  )

  // Use the exact optional peers from the repository lockfile without a second
  // registry resolution in the temporary consumer.
  linkPeer('eslint')
  linkPeer('typescript')

  execFileSync(process.execPath, ['runtime.mjs'], { cwd: consumerDirectory, stdio: 'inherit' })
  runTool('tsc', ['--project', 'tsconfig.json'], consumerDirectory)

  const sourceCheck = runCli(['--no-import', 'bad.ts'])
  const sourceOutput = `${sourceCheck.stdout}${sourceCheck.stderr}`
  assert.equal(sourceCheck.status, 1, sourceOutput)
  assert.match(sourceOutput, /unknown-element/)

  const dtoCheck = runCli(['--dtos', 'patient.dto.fixture.ts'])
  const dtoOutput = `${dtoCheck.stdout}${dtoCheck.stderr}`
  assert.equal(dtoCheck.status, 0, dtoOutput)
  assert.match(dtoOutput, /analyzed 1 DTO\(s\) from 1 module\(s\) against 1 engine\(s\)/)

  if (output !== undefined) {
    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(tarball, output, constants.COPYFILE_EXCL)
  }

  console.log(`package check: runtime, types, source CLI, and DTO CLI passed${output ? `; wrote ${output}` : ''}`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
