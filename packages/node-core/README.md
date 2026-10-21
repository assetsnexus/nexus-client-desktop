# @nexus/node-core

Headless Nexus client core shared by the Electron desktop app (main process) and
the sibling `nexus` CLI. Contains **no Electron and no browser APIs**, so both
hosts reuse it unchanged.

## Modules

| Module | Responsibility |
| --- | --- |
| `config.ts` | Connection config (gateway / region / portal + custom CA), defaults, validation |
| `auth.ts` | `anx.auth.login` / `anx.auth.twoFactorLogin`, command envelope, response normalization |
| `device.ts` | Device keypair generation, `anx.device.register`, key-store interface |
| `tls.ts` | Custom CA `https.Agent`, PEM detection/splitting |
| `secure-store.ts` | `SecureStore` interface, identity-scoped keys |
| `transport.ts` | Region-route parsing + active-region/peer state |

## Design notes

- **Desktop is a client.** Region node and inference are cloud-hosted per-region
  stacks; this package never assumes it runs next to them.
- **Gateway defaults to the region.** Gateways do not exist yet, so an unset
  gateway transparently resolves to the region URL.
- **Dependency-light.** Only Node built-ins plus `@nexus/commands-client` (public
  SDK) are used, so the package stays portable.
- **No secrets in the core.** Key material is generated locally and handed to an
  injected store (Electron `safeStorage` in the app, OS keychain in the CLI).

## Test

```bash
npm test --workspace @nexus/node-core
```
