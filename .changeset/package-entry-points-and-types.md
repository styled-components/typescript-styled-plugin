---
'@styled/typescript-styled-plugin': minor
---

`@styled/typescript-styled-plugin/api` is now a public export for both `require()` and `import()`, and the deep `lib/api` imports keep working. It adds types for building configuration by hand and for injecting custom language services. Lint settings accept `unknownAtRules`, and `globalCss` (Pigment CSS) is a default tag. 1.0.1's private underscore-prefixed modules are not included.

Thanks to @usercao for the modernization work most of this release builds on.
