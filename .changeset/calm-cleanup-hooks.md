---
'@styled/typescript-styled-plugin': patch
---

Give tsserver cleanup hooks the same timeout headroom as e2e test bodies, preventing busy CI runners from failing with Vitest's generic hook timeout before the harness can finish or report the stalled process.
