---
'@styled/typescript-styled-plugin': patch
---

Mixin interpolations that share a line with other CSS, such as `color: red; ${mixin}`, and values split across lines no longer report false `colon expected` or `semi-colon expected` errors.
