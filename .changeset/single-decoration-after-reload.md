---
'@styled/typescript-styled-plugin': patch
---

CSS diagnostics, quick fixes, and folding ranges no longer repeat after a project reloads, for example after saving a change to `tsconfig.json`. Previously each reload added another copy of every result.
