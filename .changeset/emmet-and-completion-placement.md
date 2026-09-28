---
'@styled/typescript-styled-plugin': patch
---

Emmet no longer offers whole declarations where none fit, such as inside a value: typing `display: fl` used to offer `float: left;`. Completions no longer appear inside CSS comments and strings, and an empty template now offers property suggestions. Emmet suggestions now also appear on a line that starts after a lone carriage return, a line continuation, or a line separator inside a string.
