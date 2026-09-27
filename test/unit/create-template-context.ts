import type { TemplateContext } from 'typescript-template-language-service-decorator'
import * as ts from 'typescript/lib/tsserverlibrary.js'

/**
 * A TemplateContext for `text` as the whole body of one template tagged `tagName` (the tag
 * expression written before the backtick, such as `css` or `styled.div`), in a source file holding
 * only that template. `text` is both the substituted and the raw text. Positions route through the
 * source file's own line map (TypeScript's computeLineStarts, which treats U+2028 and U+2029 as
 * line terminators like the plugin's line-start table does), so a position after a Unicode line or
 * paragraph separator is exact rather than silently wrong. `toOffset` asserts on a line past the
 * file, as tsserver does for a closed file.
 */
export function createTemplateContext(
  text: string,
  tagName = 'css',
  fileName = 'fixture.ts',
): TemplateContext {
  const sourceFile = ts.createSourceFile(
    fileName,
    `const styles = ${tagName}\`${text}\`;`,
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

  return {
    typescript: ts,
    fileName: sourceFile.fileName,
    node: initializer.template,
    text,
    rawText: text,
    toPosition(offset) {
      const position = sourceFile.getLineAndCharacterOfPosition(bodyStart + offset)
      return {
        line: position.line - bodyStartPosition.line,
        character:
          position.line === bodyStartPosition.line
            ? position.character - bodyStartPosition.character
            : position.character,
      }
    },
    toOffset(position) {
      const line = bodyStartPosition.line + position.line
      return (
        sourceFile.getPositionOfLineAndCharacter(
          line,
          position.line === 0
            ? bodyStartPosition.character + position.character
            : position.character,
        ) - bodyStart
      )
    },
  }
}
