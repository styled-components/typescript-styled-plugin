import type { MarkedString, MarkupContent } from 'vscode-css-languageservice'

/** The text of CSS service documentation, which arrives as a plain string or as markup with a `value`. */
export function markupText(content: MarkedString | MarkupContent): string {
  return typeof content === 'string' ? content : content.value
}
