---
'@styled/typescript-styled-plugin': patch
---

Diagnostics and hover are faster in large files and in templates with many interpolations. Results for unchanged templates are reused across requests, using at most 4 MB of memory per project.
