# Changelog

## 1.1.0

### Minor Changes

- 9bdd306: `@styled/typescript-styled-plugin/api` is now a public export for both `require()` and `import()`, and the deep `lib/api` imports keep working. It adds types for building configuration by hand and for injecting custom language services. Lint settings accept `unknownAtRules`, and `globalCss` (Pigment CSS) is a default tag. 1.0.1's private underscore-prefixed modules are not included.

  Thanks to @usercao for the modernization work most of this release builds on.

- 9bdd306, e13d896: On TypeScript older than 5.0, which the plugin does not support, the TypeScript server log now says that TypeScript 5.0 or newer is required, instead of showing an unexplained activation error.

  Thanks usercao!

### Patch Changes

- 9bdd306: Mixin interpolations that share a line with other CSS, such as `color: red; ${mixin}`, and values split across lines no longer report false `colon expected` or `semi-colon expected` errors.

  Thanks usercao!

- 9bdd306: Completions now follow plugin configuration changes without a restart. A completion or code fix whose edit would land outside the template is dropped instead of producing a broken edit.

  Thanks usercao!

- 9bdd306: Invalid or misspelled plugin settings are now reported in the TypeScript server log, naming the setting, what it accepts, and the closest match, instead of being ignored silently. Common spellings such as `"off"`, `"warn"`, and `"Error"` for lint levels are now accepted.

  Thanks usercao!

- 9bdd306: Errors are placed more accurately and appear in more cases:

  - Errors at the end of a template, such as an unclosed block, point inside the template instead of past its closing backtick, and an unclosed block can be folded.
  - A stray `}` or `;` is always reported, underlined where it is written.
  - Diagnostics work for files not open in the editor.
  - Templates containing U+2028 or U+2029 line separators map positions correctly.
  - A `;` or `}` inside a comment or an unquoted `url()` no longer causes a false `colon expected`.
  - `styled.keyframes` templates are checked as keyframes.
  - Code-fix requests for other error codes no longer return the plugin's fixes.
  - `getTemplateSettings().getSubstitutions` from `./api` keeps its output the same length as its input for any spans.

  Thanks usercao!

- 9bdd306: Diagnostics and hover are faster in large files and in templates with many interpolations. Results for unchanged templates are reused across requests, using at most 4 MB of memory per project.

  Thanks usercao!

- 9bdd306, e13d896: Emmet no longer offers whole declarations where none fit, such as inside a value: typing `display: fl` used to offer `float: left;`. Completions no longer appear inside CSS comments and strings, and an empty template now offers property suggestions. Emmet suggestions now also appear on a line that starts after a lone carriage return, a line continuation, or a line separator inside a string.

  Thanks usercao!

- 9bdd306: Interpolations in property names (`padding-${side}: 4px;`), at-rule conditions (`@media screen and ${query} {`), selectors (`&.${className}:hover {`), and keyframe percentages (`${step}% {`) no longer report false errors, including when a nearby comment or string holds a `;` or `{`, or a comment sits before the `{` or `:`. 1.0.1 reported these errors as well.

  Thanks usercao!

- 9bdd306: Templates are checked as the CSS styled-components actually receives, with JavaScript escapes such as `\"`, `\n`, and `\x41` read as the characters they stand for. Escapes in strings, names, and `url()` no longer report false errors, and an error on an escaped name underlines the whole escape. 1.0.1 reported these errors as well.

  Thanks usercao!

- e13d896: Interpolations written across several lines are now checked the same as when written on one line, removing false errors and wrong completions when one sits in a property name, an at-rule such as `@media` or `@keyframes`, a `url()`, a quoted string, or a comment. An interpolation inside `url()` followed by more text, such as `url(#${id}-grad)`, no longer reports a false error either. 1.0.1 reported these errors as well.
- 9bdd306: Typing `@` inside a component now suggests the at-rules that work there, such as `@media`, `@container`, `@layer`, and `@keyframes`, with their documentation.

  Thanks usercao!

- 9bdd306: A `@layer` block with declarations directly inside a component, such as `@layer utilities { color: red; }`, no longer reports a false `{ expected`. A component and a global style with the same text no longer share results.

  Thanks usercao!

- 9bdd306: An unexpected error inside the plugin, or malformed plugin configuration, is logged instead of failing the editor's whole response for the file, so TypeScript's own diagnostics and completions keep working.

  Thanks usercao!

- 9bdd306: A `css` fragment holding a single value, such as `` css`1px solid red` ``, is checked as a value instead of reporting a false `} expected`, and offers value completions.

  Thanks usercao!

## 1.0.1 - December 11, 2023

- Add support for `@container` queries by updating the CSS language service
- Update TypeScript and other dependencies

## 1.0.0 - April 3, 2023

- Fix upstream issue with typescript-template-language-service-decorator

## 0.20.0 - December 01, 2022

- Forked into @styled

## 0.18.2 - December 06, 2021

- Include completion spans in responses. Thanks @jasonwilliams!
- Don't trigger completions when opening template tags. Thanks @jasonwilliams!

## 0.18.1 - August 05, 2021

- Update emmet. Thanks @jasonwilliams!

## 0.18.0 - June 03, 2021

- Enable IntelliSense in `keyframes`. Thanks @jasonwilliams!

## 0.17.0 - May 07, 2021

- Apply in `keyframes` by default. Thanks @jasonwilliams!

## 0.16.0 - April 28, 2021

- Pick up new language service version. Thanks @hantatsang and @jasonwilliams!

## 0.15.0 - October 16, 2019

- Pick up new language service version. Thanks @apust!

## 0.14.0 - February 26, 2019

- Pick up new language service version.
- Support for dynamically changing configuration.
- Only enable plugin for TS 3.0+ in order to support automatically enabling plugin for workspace TS versions.

## 0.13.0 - November 8, 2018

- Mark color completions with the `'color'` `kindModifier`. This allows editors to render the color previews inline.
- Fix more false positive errors.

## 0.12.0 - October 15, 2018

- Pick up new decorator library version to fix a possible state corruption error.

## 0.11.0 - September 11, 2018

- Fixed some false positive errors when using a placeholder in a contexual selector. Thanks @lukyth!
- Apply in `injectGlobal` or `createGlobalStyle` by default. Thanks @scf4!

## 0.10.0 - July 10, 2018

- Add folding support.

## 0.9.2 - July 9, 2018

- Remove TS as peerDep.

## 0.9.1 - July 9, 2018

- Allow language service to be consumed by other libraries.

## 0.8.1 - July 2, 2018

- Fix some false error reports around creative uses of placeholders.

## 0.8.0 - July 2, 2018

- Support for emotion style typescript declarations.

## 0.7.0 - June 25, 2018

- Picked up new CSS version. Brings improved suggestions and better documentation.

## 0.6.3 - April 20, 2018

- Fixed `width: ${1}%;` incorrectly reported as an error.

## 0.6.2 - April 18, 2018

- Fixed case where a placeholder that looked like a mixin was incorrectly reported as an error.

## 0.6.1 - April 16, 2018

- Fixed some cases where placeholder usage was incorrectly reported as an error.

## 0.6.0 - February 16, 2018

- Added emmet suggestions. Thanks @ramya-rao-a!

## 0.5.1 - February 13, 2018

- Small fix for suggestions inside of nested selectors.

## 0.5.0 - February 12, 2018

- Add quick fixes for misspelled property names.

## 0.4.1 - February 12, 2018

- Fixed false error when placeholder is used as a selector.

## 0.4.0 - January 16, 2018

- Fix suggestions inside of nested selectors. Thanks @aczekajski!

## 0.3.1 - January 11, 2018

- Cache completion entries so we don't recompute them as often.

## 0.3.0 - January 9, 2018

- Added basic support for completion entry details

## 0.2.2 - November 29, 2017

- Fix auto import completions not showing up when using plugin with TS 2.6.2+

## 0.2.1 - November 27, 2017

- Fix cases where placeholder is followed by a trailing semicolon. Thanks @kingdaro!

## 0.2.0 - November 9, 2017

- Do not take runtime dependecy on TypeScript.

## 0.1.2 — October 24, 2017

- Fix bug that could cause errors not to be reported when on the last line of a block.

## 0.1.1 — October 24, 2017

- Compile to ES5 to support regular Visual Studio

## 0.1.0

- Support for nested classes. Thanks @asvetliakov!
- Support for styled properties, such as `MyButton.extend...`. Thanks @asvetliakov!
- Fix a bug that could cause errors to stop being reported.

### 0.0.5 - September 29, 2017

- Fix empty value error being showing when using placeholder for value in multiline template strings.

### 0.0.4 - September 29, 2017

- Fix multiline strings with placeholders.

### 0.0.3 - September 29, 2017

- Initial support for strings with placeholders.

### 0.0.2 - September 29, 2017

- Disable empty ruleset lint error by default
- Fix styled completions showing on character immediately before start of string
- Supprt `css` tag by default.
- Remove a bunch of files from published npm package.

### 0.0.1 - September 28, 2017

- Initial release
