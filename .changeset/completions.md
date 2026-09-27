---
'@styled/typescript-styled-plugin': patch
---

Completions now follow plugin configuration changes without a restart. A completion or code fix whose edit would land outside the template is dropped instead of producing a broken edit.
