/**
 * Loads the bare Monaco editor, TypeScript language service, and hover support.
 * Importing Monaco's main entry point would also register every bundled language.
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
 * Direct handle to the TypeScript worker used by the FHIRPath message channel.
 * Monaco may replace it after a TypeScript configuration change.
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
    // ESNext leaves standard decorators unchanged. ES2020 makes the sample output executable.
    target: ts.ScriptTarget.ES2020,
    useDefineForClassFields: true,
    // CommonJS turns imports into calls that the playground can provide.
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: false,
    esModuleInterop: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
    lib: ['esnext', 'dom'],
  })
  // Use package-like paths so normal `fhirpath-ts` imports resolve in Monaco.
  ts.typescriptDefaults.addExtraLib(indexDts, 'file:///node_modules/fhirpath-ts/index.d.ts')
  ts.typescriptDefaults.addExtraLib(r4Dts, 'file:///node_modules/fhirpath-ts/r4/index.d.ts')
  ts.typescriptDefaults.addExtraLib(analyzerDts, 'file:///node_modules/fhirpath-ts/analyzer/index.d.ts')
  monaco.editor.defineTheme(THEME_NAME, screenTheme())
  bindWordNavigation()
}

/**
 * Adds Ctrl+Arrow word movement on macOS without replacing Cmd+Arrow. The same
 * bindings have no effect on Windows and Linux, where the window manager receives
 * Monaco's `WinCtrl` key.
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

/** Builds the editor theme from the page variables. Monaco token colors omit `#`. */
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
