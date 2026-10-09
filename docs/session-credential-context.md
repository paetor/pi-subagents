# Session credential context (local source patch)

This patch carries an app-owned native provider credential-store binding through
local foreground and detached child construction. It does not change the model,
extension list, tools, permission ceiling, workflow permits, or provider names.

The parent registry exposes `getCredentialStoreProviders()` and
`getCredentialStore(provider)`. A routed store must implement
`exportCredentialContext()`, returning `{ module, value }`. `module` is a host-local
file URL for an app-approved credential adapter; `value` contains only non-secret
binding metadata, never access tokens, refresh tokens, passwords, or API keys.

The adapter exports `credentialStoreFromContext(value, branch)`. It returns the
native `CredentialStore` backed by the original account's coordinated storage.
The child never gets an independently copied refresh family. Loading this adapter
is an authentication-storage boundary, not a Pi extension load: no extension API
or tool grant is passed to it, and `extensions: []` stays unchanged.

Bindings are captured before the parent launch returns. Detached runner config
retains that descriptor for later steps. A child with its own provider extension
still receives the captured store before model resolution and `session_start`.
The runtime is isolated for each bound child. Nested children enumerate routed
providers, including builtins without an extension provider override.

A non-context custom session entry retains the original binding for child resume.
Its owner is the child's exact session ID, so copying a parent transcript into a
new fork does not accidentally adopt that parent's child record. A resumed
transcript may retain binding data, but it cannot select executable code: its
adapter/provider pair must also be approved by the current launch descriptor.
An adapter can honor an explicit account selection saved within the child.

An unavailable runtime, non-exportable routed store, invalid adapter, or failed
restore stops the child before inference. Host-local account bindings are not
forwarded to remote-machine launches. Existing unmanaged launches retain their
original behavior. No account context is accepted from model-authored tool
parameters.

The patch is not a published release. Activation must be paired with the reviewed
Pi runtime's public credential-store routing API and verified against the intended
host SDK before changing the user's installed package selection.
