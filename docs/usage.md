# Usage

`@styled/typescript-styled-plugin` provides CSS IntelliSense, diagnostics, code
fixes, folding, hover information, and Emmet completions in configured tagged
template literals.

## Host requirements

The plugin activates on tsserver hosts that use TypeScript 5.0 or newer (6.x
recommended) and Node.js 14.21.3 or newer. On an older TypeScript host the
plugin logs a message and leaves the host's `LanguageService` untouched
instead of activating. The tsserver plugin entry is CommonJS, loaded with a
synchronous `require()`, with no ESM interop involved. The automated suite
covers the standard Node.js tsserver path; installation alone does not prove
that an editor can load the plugin. See
[docs/tsserver-host.md](tsserver-host.md) for the verified version and
loading details behind these requirements.

A library consumer embedding the language service directly through
`@styled/typescript-styled-plugin/api` needs the same Node floor, for both
`import()` and `require()`. See [docs/tsserver-host.md](tsserver-host.md).

## Install and configure

Install the plugin beside the TypeScript version that the editor will use:

```bash
npm install --save-dev @styled/typescript-styled-plugin typescript@^6.0.3
```

Add the plugin to the project `tsconfig.json` or `jsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin"
      }
    ]
  }
}
```

The editor must be configured to use that workspace TypeScript SDK, or, in
Neovim, load the plugin as a global plugin. VS Code, Sublime Text, Neovim, and
Visual Studio setup paths are described in the
[README](../README.md#editor-integration); each requires validation against
the actual editor's tsserver host and Node runtime.

## Tagged templates

By default, the plugin recognizes these tag names:

```text
styled, css, keyframes, createGlobalStyle, globalCss, injectGlobal, extend
```

Tag matching is based on the configured name at the start or end of the tag
expression. For example, `styled.keyframes` is recognized as `keyframes` and
uses keyframe parsing. The plugin does not resolve imports, so aliases such as
`kf` must be included in `tags` and do not automatically receive keyframe
parsing.

For example:

```ts
import styled from 'styled-components'

const Button = styled.button`
  color: blue;
`
```

Tags also match a tagged template whose tag is a property-access expression
ending in the configured name, such as `Button.extend`, which ends with
`extend`. This is enabled by default:

```ts
const FancyButton = Button.extend`
  border: 10px solid hotpink;
`
```

styled-components removed `.extend` in v4 (use `styled(Component)` instead);
`extend` stays in the default tag list for projects still on an older
styled-components version, or any other tagged-template API shaped the same
way.

Set `tags` to replace the complete default list rather than add to it:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin",
        "tags": ["styled", "css", "sty"]
      }
    ]
  }
}
```

## styled-components v7

The plugin works with styled-components v7 without extra setup:

- The default tags cover v7's `styled`, `css`, `keyframes`, and
  `createGlobalStyle`. Templates from `styled-components/native` (for example
  `` styled.View`...` ``) are recognized under the same names.
- Nested at-rules inside a component, such as `@media`, `@supports`,
  `@container`, `@layer`, `@scope`, and `@starting-style`, validate without
  false errors, and typing `@` inside a component suggests them.
- Interpolations that stand in for whole declarations, such as
  `color: red; ${mixin}` or `&:hover { ${mixin} }`, and `css`
  fragments used as a value, such as `` css`${fadeIn} 1s linear` ``, validate
  without false errors.

React Native-only property names such as `margin-vertical` pass through v7
unchanged, but they are not CSS, so the plugin reports them as unknown
properties. List them in `lint.validProperties`, or silence unknown properties
entirely with `unknownProperties: "ignore"`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin",
        "lint": {
          "validProperties": ["margin-vertical", "margin-horizontal"]
        }
      }
    ]
  }
}
```

The plugin matches tags by name and does not follow imports, so an aliased
import needs its name in `tags`. For example, after
`import native from 'styled-components/native'`, templates written as
`` native.View`...` `` need `native` added (remember that `tags` replaces the
default list, so keep the defaults you still use):

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin",
        "tags": ["styled", "css", "keyframes", "createGlobalStyle", "native"]
      }
    ]
  }
}
```

## Validation and linting

CSS diagnostics are enabled by default. Disable them with `validate: false`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin",
        "validate": false
      }
    ]
  }
}
```

Use `lint` to pass CSS validation settings to
`vscode-css-languageservice`. Each listed setting accepts `"ignore"`,
`"warning"`, or `"error"` unless noted otherwise.

Library consumers can use the exported `StyledPluginLintConfiguration` and
`StyledPluginEmmetConfiguration` types for static checking. The plugin still
accepts unknown object settings from tsserver at runtime so newer upstream
settings do not cause a host failure.

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin",
        "lint": {
          "vendorPrefix": "error",
          "zeroUnits": "ignore"
        }
      }
    ]
  }
}
```

| Setting                           | Purpose                                                             | Default   |
| --------------------------------- | ------------------------------------------------------------------- | --------- |
| `validProperties`                 | Extra property names treated as valid. This is an array of strings. | Not set   |
| `unknownAtRules`                  | Unknown CSS at-rules.                                               | `warning` |
| `unknownProperties`               | Unknown CSS property names.                                         | `warning` |
| `compatibleVendorPrefixes`        | Missing related vendor-prefixed properties.                         | `ignore`  |
| `vendorPrefix`                    | Vendor-prefixed properties without a standard equivalent.           | `warning` |
| `duplicateProperties`             | Duplicate style declarations.                                       | `ignore`  |
| `emptyRules`                      | Empty rulesets.                                                     | `ignore`  |
| `importStatement`                 | `@import` statements.                                               | `ignore`  |
| `boxModel`                        | Width or height used with padding or borders.                       | `ignore`  |
| `universalSelector`               | Universal selectors.                                                | `ignore`  |
| `zeroUnits`                       | Units on zero values.                                               | `ignore`  |
| `fontFaceProperties`              | Missing `src` or `font-family` in `@font-face`.                     | `warning` |
| `hexColorLength`                  | Invalid hexadecimal color length.                                   | `error`   |
| `argumentsInColorFunction`        | Invalid color-function argument count.                              | `error`   |
| `ieHack`                          | Legacy IE hacks.                                                    | `ignore`  |
| `unknownVendorSpecificProperties` | Unknown vendor-specific properties.                                 | `ignore`  |
| `propertyIgnoredDueToDisplay`     | Properties ineffective for the selected `display`.                  | `warning` |
| `important`                       | `!important` declarations.                                          | `ignore`  |
| `float`                           | `float` declarations.                                               | `ignore`  |
| `idSelector`                      | ID selectors.                                                       | `ignore`  |

## Shorthand values and mistakes

A few spellings from other tools are accepted as the value they clearly mean:

| Setting                | Also accepts                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `tags`                 | One string, as a one-item list: `"sty"`                                                     |
| `validate`             | The strings `"true"` and `"false"`                                                          |
| `lint` levels          | `"off"` for `"ignore"`, `"warn"` for `"warning"`, and any letter case (`"Error"`, `"WARN"`) |
| `lint.validProperties` | One string, as a one-item list: `"margin-vertical"`                                         |

Any other value of the wrong kind, such as `"unknownProperties": 0` or
`"tags": 5`, is ignored and that setting keeps its default. The plugin writes
one line per ignored value to the TypeScript server log, naming the setting,
what it accepts, what it received, and which default applies:

```text
[ts-styled-plugin] Ignored the plugin setting lint.unknownProperties: it accepts "ignore", "warning", or "error"; received 0. The CSS language service's own default for this rule applies.
```

A misspelled setting name, such as `"tag"` for `"tags"`, is ignored the same
way, and its line suggests the setting it most resembles:

```text
[ts-styled-plugin] Ignored the plugin setting tag: the plugin has no setting with that name. Did you mean tags? The plugin settings are emmet, lint, tags, and validate.
```

In VS Code, turn the log on with the `js/ts.tsserver.log` setting (named
`typescript.tsserver.log` in older versions; any value other than `"off"`),
then open it with the **TypeScript: Open TS Server log** command.

## Settings sent by the editor

An editor or extension can send settings at runtime through tsserver's
`configurePlugin` request. Each such request replaces the plugin settings from
`tsconfig.json` as a whole rather than merging into them: a setting the
request leaves out returns to its default, not to the `tsconfig.json` value.

## Emmet completions

Emmet abbreviations are included in CSS completion lists where a declaration
can start, such as `m10` for `margin: 10px;`. Inside a property value, a
selector with a pseudo-class (`&:hover m10 {`), or an at-rule prelude
(`@media (min-width: m10)`), only Emmet expansions that are themselves values
are offered, such as `#12` for `#121212` or `!` for `!important`, so accepting
one never puts a declaration where none fits. Inside comments and strings,
including a string not yet closed, the plugin offers no completions at all.

Configure Emmet through the `emmet` object, which is forwarded to
`@vscode/emmet-helper`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@styled/typescript-styled-plugin",
        "emmet": {
          "showExpandedAbbreviation": "always",
          "showSuggestionsAsSnippets": true,
          "preferences": {}
        }
      }
    ]
  }
}
```

| Setting                       | Purpose                                                                                                                 | Allowed values        | Default |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------- | ------- |
| `showExpandedAbbreviation`    | Show the expanded Emmet abbreviation in the completion list; `"never"` turns Emmet completions off.                     | `"always"`, `"never"` | Not set |
| `showSuggestionsAsSnippets`   | Show Emmet suggestions as snippets, ordered by the editor's snippet-suggestion setting.                                 | `true`, `false`       | Not set |
| `excludeLanguages`            | Languages with Emmet turned off. The plugin asks for `css` completions, so `["css"]` turns Emmet completions off.       | list of strings       | Not set |
| `preferences`                 | Free-form object forwarded to `@vscode/emmet-helper` to adjust Emmet's actions and resolvers.                           | object                | `{}`    |
| `syntaxProfiles`              | Output profiles per syntax, as in VS Code's `emmet.syntaxProfiles`; the `css` profile applies here.                     | object                | Not set |
| `variables`                   | Values for the variables Emmet snippets use, as in VS Code's `emmet.variables`.                                         | object                | Not set |
| `showAbbreviationSuggestions` | Accepted for parity with VS Code's setting, but it only adds HTML abbreviation suggestions, so it has no effect in CSS. | `true`, `false`       | Not set |

TypeScript does not refresh an existing Emmet completion entry while its
abbreviation changes. Request completion again from the editor after updating
the abbreviation.
