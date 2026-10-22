//! `nexus-mount` — native mount helper for the Nexus desktop app.
//!
//! Invoked by the Electron mount daemon as `nexus-mount <config.json>` (see
//! `mount-daemon.ts`). It:
//!   1. loads the session config (snake_case JSON) and the region bearer token,
//!   2. seeds an in-memory tree from the bound bucket sub-directory,
//!   3. replays any pending write-back journal entries to the region, and
//!   4. serves the tree as a real kernel FUSE mount at the mountpoint.
//!
//! The region never exposes object-store credentials, so the helper only uses
//! short-TTL single-object presigns + region file commands — identical to the
//! daemon's mirror mode.

mod client;
mod config;
#[cfg(unix)]
mod fs;
mod journal;
mod tree;

use std::path::Path;

use anyhow::{Context, Result};
use tracing_subscriber::EnvFilter;

use crate::client::RegionClient;
use crate::config::NexusMountConfig;
#[cfg(unix)]
use crate::fs::MountState;
use crate::journal::{Journal, JournalOp};
use crate::tree::Tree;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config_path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: nexus-mount <config.json>");
            std::process::exit(2);
        }
    };

    if let Err(e) = run(Path::new(&config_path)) {
        tracing::error!("nexus-mount failed: {e:#}");
        std::process::exit(1);
    }
}

fn run(config_path: &Path) -> Result<()> {
    let cfg = NexusMountConfig::load(config_path)?;
    tracing::info!(
        "mounting workspace={} folder={} at {}",
        cfg.workspace_id,
        cfg.remote_folder_path,
        cfg.mountpoint.display()
    );

    let token = cfg.read_token()?.context(
        "no region token available yet; the desktop app must sign in before mounting",
    )?;
    let client = RegionClient::new(&cfg.region_url, token);

    // ── seed the tree from the region ────────────────────────────────────
    let mut tree = Tree::new();
    let files = client.list_files(&cfg.workspace_id)?;
    // A sub-directory mount needs the folder chain to place nested files; a
    // root mount does not, but the listing is cheap and keeps one code path.
    let folders = client.folder_index(&cfg.workspace_id).unwrap_or_default();
    let indexed = client::index_relative(&files, &folders, &cfg.remote_folder_id);
    for (rel, f) in &indexed {
        tree.upsert_file(rel, Some(f.file_id.clone()), f.size_bytes, f.revision_no);
    }
    tracing::info!("seeded {} file(s)", tree.len().saturating_sub(1));

    // ── replay pending write-back journal ────────────────────────────────
    let journal = Journal::open(&cfg.journal_path, &cfg.workspace_id)?;
    replay(&client, &journal, &cfg)?;

    #[cfg(unix)]
    {
        let state = MountState {
            cfg: cfg.clone(),
            tree: parking_lot::Mutex::new(tree),
            client,
            journal,
            folders,
            uid: current_uid(),
            gid: current_gid(),
        };

        // Touch the mountpoint so FUSE has a directory to attach to.
        std::fs::create_dir_all(&cfg.mountpoint)
            .with_context(|| format!("creating mountpoint {}", cfg.mountpoint.display()))?;

        return fs::run(state);
    }

    // Windows (WinFsp) is not wired up yet: report clearly so the daemon can
    // switch to mirror mode instead of leaving a half-present mount.
    #[cfg(not(unix))]
    {
        let _ = (tree, folders, journal, client);
        anyhow::bail!("nexus-mount has no WinFsp backend yet; use mirror mode on Windows");
    }
}

/// Replay queued local mutations against the region, oldest first, then clear.
///
/// A write carries the revision it was based on; if the region's revision has
/// moved, the entry is dropped with a warning instead of clobbering (the daemon
/// surfaces this as a conflict). Deletes are best-effort.
fn replay(client: &RegionClient, journal: &Journal, cfg: &NexusMountConfig) -> Result<()> {
    let pending = journal.pending()?;
    if pending.is_empty() {
        return Ok(());
    }
    tracing::info!("replaying {} pending mutation(s)", pending.len());
    // A file created locally journals an empty write first, then its real
    // content. Skip the empty placeholder when a later write for the same path
    // carries data, so we do not create a file we immediately supersede.
    let paths_with_content: std::collections::HashSet<&str> = pending
        .iter()
        .filter(|e| {
            e.op == JournalOp::Write
                && e.content_base64.as_ref().map(|c| !c.is_empty()).unwrap_or(false)
        })
        .map(|e| e.rel_path.as_str())
        .collect();
    let mut applied = 0usize;
    for entry in &pending {
        match entry.op {
            JournalOp::Write => {
                let Some(b64) = &entry.content_base64 else { continue };
                if b64.is_empty() && paths_with_content.contains(entry.rel_path.as_str()) {
                    applied += 1;
                    continue;
                }
                // Optimistic concurrency: skip if the remote moved past our base.
                if let (Some(base), Ok(Some(remote))) =
                    (entry.base_revision, client.revision_of(&cfg.workspace_id, &entry.rel_path))
                {
                    if remote > base {
                        tracing::warn!("skipping stale write {} (base {base})", entry.rel_path);
                        continue;
                    }
                }
                let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)?;
                match client.upload_file(&cfg.workspace_id, cfg.remote_folder_id.as_deref(), &entry.rel_path, &bytes) {
                    Ok(()) => applied += 1,
                    Err(e) => tracing::warn!("replay write {} failed: {e}", entry.rel_path),
                }
            }
            JournalOp::Delete => {
                if let Err(e) = client.delete_path(&cfg.workspace_id, &entry.rel_path) {
                    tracing::warn!("replay delete {} failed: {e}", entry.rel_path);
                } else {
                    applied += 1;
                }
            }
            JournalOp::Mkdir => {
                // Remote folders are created lazily on first write; nothing to do.
                applied += 1;
            }
        }
    }
    tracing::info!("replayed {applied}/{}", pending.len());
    journal.clear()?;
    Ok(())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(unix)]
fn current_gid() -> u32 {
    unsafe { libc::getgid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

#[cfg(not(unix))]
fn current_gid() -> u32 {
    0
}
