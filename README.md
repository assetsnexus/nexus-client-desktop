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

## Meetings and rooms (Phases 7c/7d/11/12)

A Nexus meeting is a calendar entry that links to a normal conversation room, so
meetings reuse the same room rails as DMs with agents. The cross-host meeting
model lives in `@nexus/meetings-core` with React/Vue adapters
(`@nexus/meetings-react`, `@nexus/meetings-vue3`, `@nexus/meetings-vue2`):

- **Meetings tab** — upcoming meetings rendered with the shared `MeetingCard`.
  Zoom/Teams/Google Meet/Webex/custom links open externally; nexus rooms open
  in-app; in-person/custom meetings show their description.
- **Room view** — the room roster (humans + agents) projected into a
  `RoomMediaSession` and rendered with the shared `MeetingView`: video,
  participants, screenshare, and a Scene tab. Agents (virtual employees, asset
  agents) can be muted and have listening disabled, mirroring group-conversation
  moderation.
- **VR headset preview** — the Scene tab offers "Preview in VR headset" when the
  local WebXR runtime can start an `immersive-vr` session.

The desktop has no 3D cluster-scene renderer yet, so the Scene tab shows the
room's bound scene id; the portal renders the live cluster scene.

