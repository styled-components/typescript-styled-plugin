---
'@styled/typescript-styled-plugin': patch
---

Interpolations written across several lines are now checked the same as when written on one line. This removes false errors when one sits in a property name, an at-rule such as `@media` or `@keyframes`, a `url()`, a quoted string, or a comment.
