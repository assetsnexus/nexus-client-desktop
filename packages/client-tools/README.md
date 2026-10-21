# @nexus/client-tools

Client-side tool runtime shared by the Nexus desktop app (Electron main process)
and the `nexus` CLI. Everything here is **OS-level, not UI-level**, so both hosts
reuse it verbatim.

## Security model

The main process is the **security boundary**, not the chat `access` flag. The
`access: 'read' | 'write'` hint on a tool schema is UI-only (it maps onto
Ask/Plan/Agent); real authority is:
1. the workspace sandbox (`resolveWithinWorkspace`), and
2. the bash policy (`evaluateBashCommand`) plus a hard dangerous-pattern floor.

A renderer or agent cannot bypass either by requesting a different path or
command — both checks run in the main process.

## Modules

| Module | Responsibility |
| --- | --- |
| `workspace.ts` | Workspace registry + realpath sandbox (`..`/symlink escape proof) |
| `bash-policy.ts` | Allow/deny/ask command gating + dangerous-pattern floor |
| `bash.ts` | argv-only executor (never `shell: true`), cwd-constrained, timed, env-allowlisted |
| `fs.ts` | Sandboxed read/write/edit with a revision guard (mtime + sha256) |
| `local-commands.ts` | User-managed per-OS local command skills + CPU/GPU example |

## Reference skill

`CPU_GPU_LOAD_SKILL` ships with the app: one skill, one command per OS
(`linux` / `win32` / `darwin`), registered `access: 'read'` so it runs without an
approval card in Plan mode.

## Test

```bash
npm test --workspace @nexus/client-tools
```
