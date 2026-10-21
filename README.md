# Nexus Desktop App

Cross-platform Nexus desktop client (Electron) for **Linux, Windows, and macOS**.

Reuses the existing web chat/VRM stack verbatim (`@nexus/chat-react`,
`@nexus/chat-core`, `@nexus/character-kit`, `@nexus/commands-client`) in the
Electron renderer; only the native shell is new.

## Layout

```
apps/desktop        Electron app (main + preload + renderer)
packages/node-core  Headless client core shared with the `nexus` CLI
```

## Requirements

- Node.js >= 18

## Develop

```bash
npm install
npm run dev          # launch Electron with the renderer dev server
```

## Test / typecheck

```bash
npm test
npm run typecheck
```

## Package

```bash
npm run package      # electron-builder targets for the current OS
```

Targets: `dmg`/`zip` (macOS, arm64 + x64), `nsis` installer + portable `.exe`
(Windows), `AppImage`/`deb`/`rpm` (Linux).

## Connection defaults

| Setting | Default |
| --- | --- |
| Region node | `https://1.west.eu.region.sandbox.assetsnexus.org` |
| Gateway | same as the resolved region (gateways are not deployed yet) |
| Portal | `https://portal.sandbox.assetsnexus.org` (the region may advertise its own) |

All three are overridable in settings. A custom CA (PEM) can be supplied for
local/self-signed region nodes.
