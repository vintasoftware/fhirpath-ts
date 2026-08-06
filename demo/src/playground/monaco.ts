/**
 * Monaco, narrowed to what the playground shows. Importing the `monaco-editor`
 * barrel would register every language it ships — ABAP through Solidity, plus the
 * CSS/HTML/JSON language services — so the API and the one language come from
 * their own entry points instead. Both contributions are needed: the first
 * registers the `typescript` language id, the second attaches the language
 * service that answers with types.
 *
 * `editor.api` ships the bare editor with no contributions, so the hover widget —
 * the piece that asks the language service for type info under the cursor and
 * shows marker messages — has to be pulled in explicitly.
 */

import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import { cssVar } from '../dom.ts'
import analyzerDts from '../monaco/fhirpath-ts.analyzer.d.ts?raw'
import indexDts from '../monaco/fhirpath-ts.index.d.ts?raw'
import r4Dts from '../monaco/fhirpath-ts.r4.d.ts?raw'
import tsWorker from './ts.custom.worker?worker'

export { monaco }

/** The marker owner the FHIRPath analyzer publishes under; `typescript` is Monaco's. */
export const ANALYZER_OWNER = 'fhirpath'

export const THEME_NAME = 'fhirpath-dark'

interface MonacoEnvironmentShape {
  getWorker(id: string, label: string): Worker
}

/**
 * The raw TypeScript worker, kept for the FHIRPath side channel: Monaco wraps
 * what getWorker returns in its own proxy, so the extra protocol the custom
 * worker speaks (see ts.custom.worker.ts) needs this direct handle. Created
 * lazily by Monaco; `tsWorkerHandle()` forces creation first. Monaco disposes
 * and recreates it on a `typescriptDefaults` change, so this can come back a
 * different worker — callers must notice (see requestSites in index.ts).
 */
let rawTsWorker: Worker | undefined
;(self as unknown as { MonacoEnvironment: MonacoEnvironmentShape }).MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'typescript' || label === 'javascript') {
      rawTsWorker = new tsWorker()
      return rawTsWorker
    }
    return new editorWorker()
  },
}

/** The custom TypeScript worker, forcing Monaco to create it on the first call. */
export async function tsWorkerHandle(): Promise<Worker> {
  if (rawTsWorker === undefined) {
    await monaco.languages.typescript.getTypeScriptWorker()
  }
  if (rawTsWorker === undefined) {
    throw new Error('Monaco did not create its TypeScript worker')
  }
  return rawTsWorker
}

/** Point Monaco's TypeScript worker at the package's real declarations, and theme it. */
export function configureMonaco(): void {
  const ts = monaco.languages.typescript
  ts.typescriptDefaults.setCompilerOptions({
    // Not ESNext: the DTO samples use standard decorators, which tsc only lowers
    // below an esnext target — at esnext it emits them as-is and the sandbox's
    // `new Function` would throw. (ES2022 would do; Monaco's bundled enum stops
    // at ES2020.)
    target: ts.ScriptTarget.ES2020,
    useDefineForClassFields: true,
    // CommonJS so the transpiled buffer runs in a `new Function` sandbox (imports
    // become `require(...)` calls we can intercept); inference is unaffected.
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: false,
    esModuleInterop: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
    lib: ['esnext', 'dom'],
  })
  // Placed under node_modules so `import ... from 'fhirpath-ts/r4'` resolves the
  // way it would in a real project.
  ts.typescriptDefaults.addExtraLib(indexDts, 'file:///node_modules/fhirpath-ts/index.d.ts')
  ts.typescriptDefaults.addExtraLib(r4Dts, 'file:///node_modules/fhirpath-ts/r4/index.d.ts')
  ts.typescriptDefaults.addExtraLib(analyzerDts, 'file:///node_modules/fhirpath-ts/analyzer/index.d.ts')
  monaco.editor.defineTheme(THEME_NAME, screenTheme())
  bindWordNavigation()
}

/**
 * Ctrl + arrow moves by word, and with Shift selects by word — the binding
 * everything else on the page (the browser's own inputs included) uses.
 *
 * Only the literal Ctrl key is bound, which is `WinCtrl` in Monaco's vocabulary:
 * `CtrlCmd` would mean Cmd on macOS, where Cmd + arrow is line start/end and
 * stealing it would be worse than the gap this closes. On Windows and Linux
 * Ctrl + arrow is already word navigation, and `WinCtrl` there is the Super key
 * the window manager takes first, so these rules are a no-op.
 */
function bindWordNavigation(): void {
  const { KeyMod, KeyCode } = monaco
  monaco.editor.addKeybindingRules([
    { keybinding: KeyMod.WinCtrl | KeyCode.LeftArrow, command: 'cursorWordLeft' },
    { keybinding: KeyMod.WinCtrl | KeyCode.RightArrow, command: 'cursorWordRight' },
    { keybinding: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.LeftArrow, command: 'cursorWordLeftSelect' },
    { keybinding: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.RightArrow, command: 'cursorWordRightSelect' },
  ])
}

/**
 * The editor theme, built from the same `:root` custom properties the rest of the
 * page uses, so the palette has one home. Monaco wants bare hex for token colors
 * and `#rrggbb` for its own keys.
 */
function screenTheme(): monaco.editor.IStandaloneThemeData {
  const screen = cssVar('--screen')
  const raised = cssVar('--screen-2')
  const line = cssVar('--screen-line')
  const ink = cssVar('--screen-ink')
  const muted = cssVar('--screen-muted')
  const pulse = cssVar('--pulse')
  const bare = (color: string): string => color.replace('#', '')
  return {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string', foreground: bare(pulse) },
      { token: 'keyword', foreground: bare(cssVar('--tok-keyword')) },
      { token: 'comment', foreground: bare(muted), fontStyle: 'italic' },
      { token: 'number', foreground: bare(cssVar('--caution')) },
      { token: 'identifier', foreground: bare(ink) },
      { token: 'delimiter', foreground: bare(cssVar('--tok-delimiter')) },
    ],
    colors: {
      'editor.background': screen,
      'editor.foreground': ink,
      'editorLineNumber.foreground': cssVar('--screen-dim'),
      'editorLineNumber.activeForeground': muted,
      'editorCursor.foreground': pulse,
      'editor.selectionBackground': `${pulse}3d`,
      'editorGutter.background': screen,
      'editorWidget.background': raised,
      'editorWidget.border': line,
      'editorSuggestWidget.background': raised,
      'editorHoverWidget.background': raised,
      'editorHoverWidget.border': line,
    },
  }
}
