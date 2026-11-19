---
'@styled/typescript-styled-plugin': patch
---

Misspelled properties inside keyframe blocks, such as `opacitty` in `0% { opacitty: 0; }`, now report an unknown-property warning with a rename fix when a close match exists, both in a `keyframes` template and in an `@keyframes` rule nested in any other styled template.
