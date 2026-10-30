---
'@styled/typescript-styled-plugin': patch
---

Keep normalized tag arrays and top-level Emmet options independent of caller mutations, and preserve unknown lint keys as own properties.

Reject invalid array lengths and fall back to defaults when direct JavaScript API callers supply configuration values that throw while being read.
