---
'@styled/typescript-styled-plugin': patch
---

Interpolations written across several lines are now checked the same as when written on one line, removing false errors and wrong completions when one sits in a property name, an at-rule such as `@media` or `@keyframes`, a `url()`, a quoted string, or a comment. An interpolation inside `url()` followed by more text, such as `url(#${id}-grad)`, no longer reports a false error either. 1.0.1 reported these errors as well.
