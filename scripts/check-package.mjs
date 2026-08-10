import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const rawArguments = process.argv.slice(2)
const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--output')) {
  throw new Error('usage: pnpm check:package [-- --output <tarball>]')
}
const output = arguments_[1] === undefined ? undefined : resolve(arguments_[1])
const temporaryRoot = mkdtempSync(join(tmpdir(), 'fhirpath-ts-package-'))
const packDirectory = join(temporaryRoot, 'pack')
const consumerDirectory = join(temporaryRoot, 'consumer')
const npmEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_'))
)

const tools = {
  npm: join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  publint: join(root, 'node_modules', 'publint', 'src', 'cli.js'),
  attw: join(root, 'node_modules', '@arethetypeswrong', 'cli', 'dist', 'index.js'),
}

function run(name, args, cwd = root) {
  execFileSync(process.execPath, [tools[name], ...args], {
    cwd,
    stdio: 'inherit',
    ...(name === 'npm' && { env: npmEnvironment }),
  })
}

function linkPeer(name) {
  const source = join(root, 'node_modules', name)
  if (!existsSync(source)) {
    throw new Error(`Missing ${name}; run pnpm install before pnpm check:package`)
  }
  symlinkSync(source, join(consumerDirectory, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
}

function runCli(args) {
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

  mkdirSync(packDirectory)
  mkdirSync(consumerDirectory)

  const packOutput = execFileSync(
    process.execPath,
    [tools.npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: npmEnvironment }
  )
  const [{ filename }] = JSON.parse(packOutput)
  assert.equal(typeof filename, 'string', 'npm pack did not report a tarball filename')
  const tarball = join(packDirectory, filename)

  run('publint', ['run', tarball, '--strict', '--pack=false'])
  run('attw', [tarball, '--profile', 'esm-only'])

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'fhirpath-ts-package-check', private: true, type: 'module' }, null, 2)}\n`
  )
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    consumerDirectory
  )

  // Use the exact optional peers from the repository lockfile without a second
  // registry resolution in the temporary consumer.
  linkPeer('eslint')
  linkPeer('typescript')

  writeFileSync(
    join(consumerDirectory, 'runtime.mjs'),
    `import assert from 'node:assert/strict'
import { FhirPathEngine } from 'fhirpath-ts'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import plugin from 'fhirpath-ts/eslint'
import packageMetadata from 'fhirpath-ts/package.json' with { type: 'json' }
import { r4 } from 'fhirpath-ts/r4'
import { createSiteFinder } from 'fhirpath-ts/sites'
import ts from 'typescript'

assert.equal(typeof FhirPathEngine, 'function')
assert.deepEqual(r4.evaluate('Patient.name.given', {
  resourceType: 'Patient',
  name: [{ given: ['Ada'] }],
}), ['Ada'])
assert.deepEqual(analyzeExpression('Patient.name'), [])
assert.equal(plugin.meta.name, packageMetadata.name)
assert.equal(plugin.meta.version, packageMetadata.version)
const source = "import { compile } from 'fhirpath-ts'\\nconst path = compile('Patient.name')"
assert.equal(createSiteFinder(ts)(source, 'consumer.ts').length, 1)
`
  )
  execFileSync(process.execPath, ['runtime.mjs'], { cwd: consumerDirectory, stdio: 'inherit' })

  writeFileSync(
    join(consumerDirectory, 'typecheck.ts'),
    `import { FhirPathEngine } from 'fhirpath-ts'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import plugin from 'fhirpath-ts/eslint'
import { r4 } from 'fhirpath-ts/r4'
import { createSiteFinder } from 'fhirpath-ts/sites'
import ts from 'typescript'

new FhirPathEngine().evaluate('1 + 1')
r4.evaluate('Patient.active', { resourceType: 'Patient', active: true })
analyzeExpression('Patient.active')
createSiteFinder(ts)
plugin.rules['no-invalid-expressions']
`
  )
  writeFileSync(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ['typecheck.ts'],
      },
      null,
      2
    )}\n`
  )
  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'],
    { cwd: consumerDirectory, stdio: 'inherit' }
  )

  writeFileSync(join(consumerDirectory, 'bad.ts'), 'const invalid = fhirpath`Patient.nope`\n')
  const sourceCheck = runCli(['--no-import', 'bad.ts'])
  const sourceOutput = `${sourceCheck.stdout}${sourceCheck.stderr}`
  assert.equal(sourceCheck.status, 1, sourceOutput)
  assert.match(sourceOutput, /unknown-element/)

  writeFileSync(
    join(consumerDirectory, 'patient.dto.ts'),
    `import { column, defineDto, FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

export class PatientRow extends defineDto('Patient') {
  @column('name.family.first()', { default: '' })
  family!: string
}

export const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [PatientRow] })
`
  )
  const dtoCheck = runCli(['--dtos', 'patient.dto.ts'])
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
