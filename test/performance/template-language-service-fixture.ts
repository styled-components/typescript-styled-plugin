import type { TemplateContext } from 'typescript-template-language-service-decorator'
import * as ts from 'typescript/lib/tsserverlibrary.js'

import { PluginConfigurationManager } from '../../src/configuration/plugin-configuration.ts'
import { StyledTemplateLanguageService } from '../../src/template-language-service.ts'
import { getTemplateSubstitutions } from '../../src/template/template-substitutions.ts'
import { StyledVirtualDocumentProvider } from '../../src/virtual-document/styled-virtual-document-provider.ts'

/** A half-open range of template offsets, the shape the decorator's placeholder spans take. */
export interface TemplateSpan {
  readonly end: number
  readonly start: number
}

export function createTemplateLanguageService(): StyledTemplateLanguageService {
  return new StyledTemplateLanguageService(
    ts,
    new PluginConfigurationManager(),
    new StyledVirtualDocumentProvider(ts),
  )
}

/**
 * Mirrors StandardTemplateContext (typescript-template-language-service-decorator's
 * standard-template-source-helper.js): toPosition/toOffset resolve through the source file's own
 * line map (computed once, then binary-searched per call by TypeScript) rather than re-splitting
 * the template text on every call, so the benchmark measures the same cost shape production pays.
 * `substitutionSpans` mirrors the decorator's own PlaceholderSubstituter.getPlaceholderSpans
 * output (each span covers a whole `${...}` placeholder, delimiters included:
 * node_modules/typescript-template-language-service-decorator/lib/standard-template-source-
 * helper.js): when given, `context.text` is the real, length-preserving substitution
 * (getTemplateSubstitutions, src/template/template-substitutions.ts) production computes for
 * every request, not `rawText` with the placeholder syntax left in place, so a benchmark over an
 * interpolated template measures the same substituted text tsserver actually translates.
 *
 * `text` is a lazy getter, computed on first read and memoized only for the one context object it
 * belongs to, the same contract StandardTemplateContext gives it: reading `rawText` alone, or never
 * reading either, costs nothing beyond the parse below, which every context pays regardless (it
 * builds `node`, `toPosition`, and `toOffset`). Splitting `createTemplateContextFactory` out from
 * `createTemplateContext` lets a caller that needs many independently-memoized contexts over the
 * same template (template-language-service.bench.ts, one context per iteration, mirroring a fresh
 * request per keystroke) pay that one-time parse once, not once per context.
 */
export function createTemplateContextFactory(
  rawText: string,
  substitutionSpans: readonly TemplateSpan[] = [],
): () => TemplateContext {
  const sourceFile = ts.createSourceFile(
    'performance-fixture.ts',
    `const styles = css\`${rawText}\`;`,
    ts.ScriptTarget.Latest,
    true,
  )
  const statement = sourceFile.statements[0]
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error('Expected a variable statement.')
  }
  const initializer = statement.declarationList.declarations[0]?.initializer
  if (!initializer || !ts.isTaggedTemplateExpression(initializer)) {
    throw new Error('Expected a tagged template expression.')
  }
  const bodyStart = initializer.template.getStart(sourceFile) + 1
  const bodyStartPosition = sourceFile.getLineAndCharacterOfPosition(bodyStart)

  const toPosition: TemplateContext['toPosition'] = (offset) => {
    const position = sourceFile.getLineAndCharacterOfPosition(bodyStart + offset)
    return {
      line: position.line - bodyStartPosition.line,
      character:
        position.line === bodyStartPosition.line
          ? position.character - bodyStartPosition.character
          : position.character,
    }
  }
  const toOffset: TemplateContext['toOffset'] = (position) => {
    const line = bodyStartPosition.line + position.line
    return (
      sourceFile.getPositionOfLineAndCharacter(
        line,
        position.line === 0 ? bodyStartPosition.character + position.character : position.character,
      ) - bodyStart
    )
  }

  return () => {
    let text: string | undefined
    return {
      typescript: ts,
      fileName: sourceFile.fileName,
      node: initializer.template,
      rawText,
      get text() {
        if (text === undefined) {
          text =
            substitutionSpans.length > 0
              ? getTemplateSubstitutions(rawText, substitutionSpans)
              : rawText
        }
        return text
      },
      toOffset,
      toPosition,
    }
  }
}

export function createTemplateContext(
  rawText: string,
  substitutionSpans: readonly TemplateSpan[] = [],
): TemplateContext {
  return createTemplateContextFactory(rawText, substitutionSpans)()
}

/** One misspelled property ("colr") per rule, so this yields exactly `ruleCount` diagnostics. */
export function createDiagnosticsTemplate(ruleCount: number): string {
  return Array.from(
    { length: ruleCount },
    (_, index) => `.rule-${index} { colr: red; margin: 0; }`,
  ).join('\n')
}

/** One rule per fold, split across lines so each rule body is a distinct folding range. */
export function createFoldingTemplate(ruleCount: number): string {
  return Array.from(
    { length: ruleCount },
    (_, index) => `.rule-${index} {\n  color: red;\n  margin: 0;\n}`,
  ).join('\n')
}

/** `ruleCount` valid rules, then `tail` on its own last line, where a completion request goes. */
export function createLargeTemplate(ruleCount: number, tail = 'color:'): string {
  return (
    Array.from(
      { length: ruleCount },
      (_, index) => `.rule-${index} { color: red; margin: 0; padding: 0; }`,
    ).join('\n') + `\n${tail}`
  )
}

/**
 * Returns global gc, or fails loudly: without `--expose-gc` a heap reading around a skipped
 * collection measures garbage, not retention. `scriptName` is the package script that passes the
 * flag.
 */
export function requireGc(scriptName: string): () => void {
  const { gc } = globalThis
  if (!gc) {
    throw new Error(
      `Heap measurement needs global gc, which only Node's --expose-gc flag provides: run ` +
        `\`corepack yarn ${scriptName}\`, which passes it, instead of invoking this file directly.`,
    )
  }
  return gc
}

/**
 * Returns heapUsed once it stops shrinking between collections (or after 10 collections). Yields
 * one macrotask first, so FinalizationRegistry callbacks and other queued work that would free
 * memory run before the first collection instead of reading as retained.
 */
export async function settleHeap(gc: () => void): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  let previous = Infinity
  let current = process.memoryUsage().heapUsed
  for (let i = 0; i < 10 && current < previous - 16 * 1024; i++) {
    gc()
    previous = current
    current = process.memoryUsage().heapUsed
  }
  return current
}
