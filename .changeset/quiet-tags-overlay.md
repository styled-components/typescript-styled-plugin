---
'@styled/typescript-styled-plugin': minor
---

Add the version 1 editor configuration protocol and its named version constant so editor integrations can append tagged-template names without replacing project tags, validation, lint, or Emmet settings.

Keep dynamic configuration consistent across project reloads, preserve configuration fields without changing object prototypes, and avoid clearing caches for an initial overlay that leaves the effective configuration unchanged.
