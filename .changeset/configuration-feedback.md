---
'@styled/typescript-styled-plugin': patch
---

Invalid or misspelled plugin settings are now reported in the TypeScript server log, naming the setting, what it accepts, and the closest match, instead of being ignored silently. Common spellings such as `"off"`, `"warn"`, and `"Error"` for lint levels are now accepted.
