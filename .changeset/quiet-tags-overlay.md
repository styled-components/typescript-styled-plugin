---
'@styled/typescript-styled-plugin': minor
---

Add an editor configuration protocol so editor integrations can append tagged-template names without replacing project tags, validation, lint, or Emmet settings.

Keep dynamic configuration consistent across project reloads, remove configuration listeners when projects close, refresh diagnostics once per project service when effective settings change, and avoid clearing caches or refreshing diagnostics for no-op updates.
