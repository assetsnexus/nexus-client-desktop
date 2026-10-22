# `nexus-mount` — native mount helper

Projects a Nexus storage bucket (or a sub-directory of one) as a real kernel
filesystem directory. It is the native half of the desktop mount feature; the
Electron daemon in `apps/desktop/src/main/mount-daemon.ts` supervises it.

The helper is **optional**. When the binary is absent (or FUSE is unavailable)
the daemon runs its pure-JS *mirror mode* instead. Nothing in the app requires
the helper, so packaging never fails because a Rust toolchain is missing.

## Contract

The daemon writes `<userData>/mounts/<session>.helper.json` and spawns
`nexus-mount <config.json>`:

```json
{
  "mountpoint": "/home/me/Nexus/Clients",
  "workspace_id": "w1",
  "remote_folder_id": "clients",
  "remote_folder_path": "/Projects/Clients",
  "read_only": false,
  "cache_dir": "/home/me/.cache/nexus/mounts/<id>",
  "journal_path": "/home/me/.cache/nexus/mounts/<id>.journal.jsonl",
  "region_url": "https://region.example",
  "token_path": "/home/me/.cache/nexus/mounts/<id>.token",
  "volume_name": "Nexus"
}
```

The bearer token is **not** inlined: `token_path` points at a `0600` file the
daemon keeps fresh, so rotation/revocation takes effect without restarts.

## Behaviour

1. Seed an in-memory tree from the bound sub-directory (`anx.storage.bucket.list-files`).
2. Replay any pending write-back journal entries (oldest first) with optimistic
   concurrency — a write that carries `base_revision` is dropped if the region
   has moved past it, rather than clobbering.
3. Serve the tree over FUSE:
   - reads hydrate into `cache_dir` via a short-TTL single-object presign
     (`anx.storage.presign.get`); no object-store credentials ever reach the process
   - writes hit the cache immediately and append a JSONL journal entry
   - `read_only` sessions reject every mutation with `EROFS`

## Layout

| File | Purpose |
| --- | --- |
| `src/config.rs` | Config contract + validation + token file |
| `src/client.rs` | Region command client (presign reads, upload writes) |
| `src/tree.rs` | Pure in-memory directory model (unit-tested) |
| `src/journal.rs` | Content cache paths + append-only write-back journal |
| `src/fs.rs` | `fuser::Filesystem` adapter over the tree |
| `src/main.rs` | Entrypoint: seed → replay → mount |

## Build & test

```sh
# unit tests (no FUSE needed)
cargo test --manifest-path native/Cargo.toml

# release binary
cargo build --release --manifest-path native/Cargo.toml

# end-to-end: stub region + real FUSE mount (skips if /dev/fuse is absent)
node native/smoke-mount.mjs native/target/release/nexus-mount
```

From the desktop app: `npm run build:native` stages the binary to
`apps/desktop/dist-native/<platform>-<arch>/nexus-mount`, where the daemon finds
it before falling back to `PATH`.

## Platform status

- **Linux** — kernel FUSE (`/dev/fuse`); built and end-to-end tested.
- **macOS** — macFUSE via the same `fuser` backend; requires macFUSE installed.
- **Windows** — the pure tree model is platform-neutral, but the `fuser` mount
  call is Unix-only. A WinFsp adapter (`fs.rs`) is the remaining piece; until
  then Windows runs mirror mode.
