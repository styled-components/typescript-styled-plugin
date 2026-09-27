---
'@styled/typescript-styled-plugin': patch
---

Interpolations in property names (`padding-${side}: 4px;`), at-rule conditions (`@media screen and ${query} {`), selectors (`&.${className}:hover {`), and keyframe percentages (`${step}% {`) no longer report false errors, including when a nearby comment or string holds a `;` or `{`, or a comment sits before the `{` or `:`. 1.0.1 reported these errors as well.
