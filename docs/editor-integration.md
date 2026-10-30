# Editor integration protocol

This contract is for editor extension authors, language server adapters, and
other hosts that load `@styled/typescript-styled-plugin` through tsserver. It
defines how to add tagged-template names without replacing a project's plugin
settings. End-user setup belongs in the [usage guide](usage.md); plugin internals
belong in [Architecture](architecture.md#configuration).

## Availability

The editor configuration protocol is implemented in this source tree and has a
pending minor changeset. It is not available in version 1.1.1. Before enabling
it in a released adapter, require a published plugin version that includes this
protocol and verify the version actually loaded by the host. A dependency range
alone does not prove which copy tsserver loads.

An older plugin interprets the envelope as a legacy configuration replacement
and can reset project settings to defaults. Do not send the envelope to a host
whose plugin version is unknown or unsupported. There is no version negotiation
or capability query in this protocol. Use a local packed build or a release
workflow snapshot for adapter development before the first supporting release.

The host must support tsserver plugins and meet the
[host requirements](usage.md#host-requirements). A compiler or language server
without the tsserver plugin API cannot use this transport; see the
[TypeScript host notes](tsserver-host.md#typescript-versions-2026-09-26).

## Payload

Send `configurePlugin` with the plugin name
`@styled/typescript-styled-plugin` and this configuration:

```json
{
  "editorConfiguration": {
    "extraTags": ["globalStyle", "styledNative"]
  }
}
```

The outer object and `editorConfiguration` must be plain objects. The envelope
is identified by its own `editorConfiguration` key; an invalid envelope is not
reinterpreted as a legacy replacement. `extraTags` is required and must be an
array. Import `StyledPluginEditorConfiguration` and
`StyledPluginEditorConfigurationEnvelope` as types from
`@styled/typescript-styled-plugin/api`; do not add protocol fields to the
project's `StyledPluginConfigurationInput`.

No `protocolVersion` or `source` field is required. Unknown envelope and editor
configuration fields are logged and ignored; tsserver's `name` and `global`
metadata are silently ignored. Unknown fields do not select a new behavior.

### Normalization

The plugin keeps string entries, trims their ends, drops empty strings, and
deduplicates in first-occurrence order. Matching is case-sensitive. Internal
characters are preserved, and tags need not be JavaScript identifiers. There
is no count, per-tag length, or total-length limit.

| Input `extraTags`                          | Result                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `[" customTag ", "customTag", "otherTag"]` | Replace the overlay with `["customTag", "otherTag"]`. |
| `[1, null, " customTag ", ""]`             | Skip bad entries and use `["customTag"]`.             |
| `[1, null, " "]` or `["", "   "]`          | Invalid; preserve the current dynamic configuration.  |
| `"customTag"`, `null`, or a missing field  | Invalid; preserve the current dynamic configuration.  |
| `[]`                                       | Clear the overlay and restore the project base.       |

A non-empty array that normalizes to no tags is invalid. Only an empty input
array requests a clear. The adapter must retain this distinction before sending
or persisting a payload, even if its settings UI validates the input.

An extra tag is a text match, not a parsing mode or an import alias. Adding
`globalStyle` enables CSS language features in that tagged template, but does
not give it the global stylesheet parsing mode of built-in tags such as
`createGlobalStyle`. Ordinary function calls and untagged templates do not
become candidates. This protocol does not change syntax highlighting. See
[Tag matching](tsserver-host.md#tag-matching) for the matching rules.

## Configuration state

Each project keeps its own base settings from its plugin entry, or the plugin
defaults when no entry exists. One dynamic configuration is shared within a
tsserver `ProjectService`; separate services do not share it.

| Incoming configuration                  | Effective settings                                                 |
| --------------------------------------- | ------------------------------------------------------------------ |
| Valid editor envelope                   | Project base with the supplied overlay appended.                   |
| Valid envelope with `extraTags: []`     | Project base, with no additional tags.                             |
| Invalid editor envelope                 | Previous dynamic state, unchanged.                                 |
| Legacy payload without the envelope key | Complete runtime replacement; omitted settings return to defaults. |

The last valid dynamic configuration kind wins. An editor envelope replaces
any legacy runtime replacement, restores each project's base, and then appends
the overlay. A legacy payload removes the overlay. An invalid envelope preserves
either kind of state, not only an existing editor overlay.

Project tags keep their order and contents. Additional tags follow them, with
duplicates of base tags or earlier additions omitted. The envelope cannot
change `validate`, `lint`, or `emmet`. For example, project tags
`["css", "projectTag"]` plus overlay `["projectTag", "customTag"]` produce
`["css", "projectTag", "customTag"]`.

Each envelope is a complete replacement of the overlay, not a patch. Multiple
senders must coordinate in the host; the plugin does not keep an overlay per
sender, workspace folder, or project. Do not expose per-folder settings unless
the host routes them to separate project services.

Configuration can arrive before the first project opens or after projects are
loaded. Later projects inherit the current dynamic state while keeping their
own bases. Project reloads do not require the adapter to reconstruct project
settings or merge them into the envelope.

When effective settings change, the plugin updates all live managers and calls
`refreshDiagnostics()` once per live project. A refresh failure in one project
does not stop the others. Hosts must handle the resulting
`projectsUpdatedInBackground` event and request updated diagnostics for open
files. Invalid payloads and updates that leave effective settings unchanged do
not clear caches or request diagnostic refreshes. The event is a refresh
notification, not a protocol acknowledgment.

## Building a payload

This adapter-side example accepts untrusted setting values. It returns a
discriminated result: a caller cannot send an envelope from the invalid branch.
The function and result type are example adapter code, not plugin exports.
The plugin still validates every payload independently.

```ts
import type { StyledPluginEditorConfigurationEnvelope } from '@styled/typescript-styled-plugin/api'

type EditorConfigurationResult =
  | { readonly ok: false; readonly reason: string }
  | { readonly configuration: StyledPluginEditorConfigurationEnvelope; readonly ok: true }

function createEditorConfiguration(value: unknown): EditorConfigurationResult {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'extraTags must be an array.' }
  }

  const extraTags: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const tag = entry.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      extraTags.push(tag)
    }
  }

  if (value.length > 0 && extraTags.length === 0) {
    return { ok: false, reason: 'A non-empty extraTags array must contain a non-empty string.' }
  }

  return { configuration: { editorConfiguration: { extraTags } }, ok: true }
}
```

On `ok: false`, report the reason and keep the last valid desired configuration
and last sent payload. Do not send, persist, or replay an empty envelope as a
fallback. On `ok: true`, use `result.configuration` only after applying the
sending rules below. A valid empty array is a clear request, not automatically
permission to send one on startup.

If an absent host setting means an empty list, map only `undefined` to `[]`
before calling the function. Do not use `value ?? []`, which would also turn
an invalid `null` into a clear request. A settings schema is not a substitute
for this runtime check.

## Adapter lifecycle

Keep the latest valid desired payload separately from the last successfully
sent payload. Invalid settings must not replace either. The host's stored
payload must also stay valid: a fresh tsserver process cannot recover a previous
process's state if the host replays only an invalid update.

For an adapter that only owns the additional-tags setting:

1. On initial activation with a missing or empty setting, send nothing. An
   empty envelope can undo another sender's legacy replacement.
2. On valid non-empty settings, send the complete normalized envelope. Skip
   an equivalent payload already sent in the same host session.
3. After sending a non-empty overlay, send `[]` when the user clears or removes
   the setting. Invalid non-empty arrays leave the last valid state intact.
4. Serialize asynchronous initialization and sends. Before dispatch, check the
   latest setting revision and plugin-loading conditions so a delayed operation
   cannot overwrite a newer value. Invalid updates preserve the last valid
   desired payload, including while initialization is pending.
5. On a new host session, reconstruct the desired state from settings. If the
   host does not replay configuration after a tsserver restart, replay the last
   valid payload, including a clear sent in the current host session. Reset
   send-deduplication state when the transport loses its saved configuration.

Do not restart tsserver just to apply a setting change. A successful transport
call alone does not prove the expected plugin loaded or accepted the payload.
Keep diagnostics about adapter failures separate from plugin acceptance, and
avoid logging source text, tag contents, or complete workspace settings.

## VS Code adapters

The built-in `vscode.typescript-language-features` extension exposes API v0
with `configurePlugin(pluginId, configuration)`. Obtain it through
`getAPI(0)` after activation. Pass the npm plugin name, not the adapter's
extension ID. Keep the configuration builder independent of VS Code so its
validation and lifecycle can be tested without an Extension Host.

Use a window-scoped additional-tags setting. Ensure the bridge activates for
JavaScript and TypeScript as well as JSX and TSX, including startup with an
existing setting. Cache API initialization and enforce the revision checks
above across activation and configuration changes.

VS Code keeps the last plugin configuration in Extension Host memory and
replays it when tsserver restarts. It does not survive Reload Window or a new
Extension Host; initialize from settings on activation. The implementation is
documented with source references in the
[VS Code host notes](tsserver-host.md#vs-code-configuration-transport-2026-10-30).

API v0 does not report the loaded plugin path, version, or acceptance of the
payload. Before sending, check custom tsserver plugin paths and other enabled
extensions contributing the same plugin name. If these make the loaded version
uncertain, do not send an envelope; report the conflict and how to resolve it.
Recheck these conditions after asynchronous initialization and when they change.
This cannot discover callers that only use `configurePlugin`, so adapters still
need to disclose the single-overlay behavior.

There is no API v0 operation to withdraw the saved configuration. If a loading
conflict appears after sending, stop new sends and ask the user to resolve the
conflict and reload the window. Merely stopping sends does not prevent replay
of the saved payload to a different plugin after a server restart. Do not try
to withdraw it with an empty envelope or a legacy payload.

Import the protocol types with `import type`. Keep the tsserver plugin's
CommonJS entry independently loadable in the shipped extension rather than
bundling it into the Extension Host entry. Validate the final VSIX, not only
the development dependency tree.

## Validation and release

An adapter's tests should cover these observable results:

- A new tag receives completions and diagnostics or hover while project tags
  keep working and untagged templates stay untouched.
- Project `validate`, `lint`, and `emmet` survive adding and clearing tags.
- Mixed arrays retain valid entries; all-invalid non-empty arrays keep the
  previous state; only a real empty array clears it. Include startup without
  a previous value and updates while initialization is pending.
- Initial empty settings send nothing. Repeated normalized settings do not
  cause extra sends. Rapid changes cannot send an older value last.
- Legacy replacement, editor overlay, and clear transitions agree before and
  after project creation, project reload, and host replay.
- Open files receive fresh diagnostics after a real change without an edit.
- Multiple projects keep independent bases while sharing one overlay.
- Missing host APIs, send failures, and plugin-loading conflicts leave the
  adapter's other features available.
- The final packaged adapter loads the expected plugin under every supported
  host version, including VS Code's bundled and workspace TypeScript paths
  where the adapter supports them.

Pair negative assertions with a positive control in the same session: an
unloaded plugin also returns no CSS diagnostics or completions. The plugin's
own [test and release gates](maintenance.md#testing-changes) do not replace
tests of the adapter's transport and packaging.

Link to this document from adapter repositories instead of copying the
contract. Pin the link to the plugin commit or release tag used for integration,
and record the supported published package version. Enable the feature in a
released adapter only after its dependency, lockfile, and shipped artifact all
contain a supporting plugin version and its integration tests pass.
