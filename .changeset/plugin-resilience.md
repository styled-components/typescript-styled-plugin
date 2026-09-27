---
'@styled/typescript-styled-plugin': patch
---

An unexpected error inside the plugin, or malformed plugin configuration, is logged instead of failing the editor's whole response for the file, so TypeScript's own diagnostics and completions keep working.
