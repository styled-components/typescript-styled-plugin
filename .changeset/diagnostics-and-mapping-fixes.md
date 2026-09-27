---
'@styled/typescript-styled-plugin': patch
---

Errors are placed more accurately and appear in more cases:

- Errors at the end of a template, such as an unclosed block, point inside the template instead of past its closing backtick, and an unclosed block can be folded.
- A stray `}` or `;` is always reported, underlined where it is written.
- Diagnostics work for files not open in the editor.
- Templates containing U+2028 or U+2029 line separators map positions correctly.
- A `;` or `}` inside a comment or an unquoted `url()` no longer causes a false `colon expected`.
- `styled.keyframes` templates are checked as keyframes.
- Code-fix requests for other error codes no longer return the plugin's fixes.
- `getTemplateSettings().getSubstitutions` from `./api` keeps its output the same length as its input for any spans.
