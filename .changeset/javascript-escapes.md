---
'@styled/typescript-styled-plugin': patch
---

Templates are checked as the CSS styled-components actually receives, with JavaScript escapes such as `\"`, `\n`, and `\x41` read as the characters they stand for. Escapes in strings, names, and `url()` no longer report false errors, and an error on an escaped name underlines the whole escape. 1.0.1 reported these errors as well.
