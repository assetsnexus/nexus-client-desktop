//! Helper configuration — the contract with the Electron mount daemon.
//!
//! The daemon writes this JSON to `<userData>/mounts/<session>.helper.json` and
//! spawns `nexus-mount <config.json>` (see
//! `anx-desktop-app/apps/desktop/src/main/mount-daemon.ts`). The token is **not**
//! inlined: `token_path` points at a 0600 file the daemon keeps fresh, so a
//! rotated/revoked token takes effect without restarting the helper.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Mirrors the daemon's `config` object (snake_case at the edge).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusMountConfig {
    /// Directory the bucket appears under.
    pub mountpoint: PathBuf,
    /// Region storage workspace / bucket id.
    pub workspace_id: String,
    /// Remote sub-directory folder id, or `null` for the bucket root.
    #[serde(default)]
    pub remote_folder_id: Option<String>,
    /// Display path of the remote sub-directory (e.g. `/Projects/Clients`).
    #[serde(default = "default_root_path")]
    pub remote_folder_path: String,
    /// Whether writes are rejected (the daemon downgrades non-writable workspaces).
    #[serde(default)]
    pub read_only: bool,
    /// Directory for cached content (content-addressed).
    pub cache_dir: PathBuf,
    /// Append-only write-back journal (JSONL).
    pub journal_path: PathBuf,
    /// Region node base URL (e.g. `https://region.example`).
    pub region_url: String,
    /// File the daemon writes the bearer token to (owner-only).
    pub token_path: PathBuf,
    /// Filesystem label shown by the OS.
    #[serde(default = "default_volume")]
    pub volume_name: String,
}

fn default_root_path() -> String {
    "/".to_string()
}

fn default_volume() -> String {
    "Nexus".to_string()
}

impl NexusMountConfig {
    /// Load and validate a config file. Relative cache/journal paths are
    /// resolved against the config file's directory so the daemon can pass a
    /// bare filename if it ever wants to.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading mount config {}", path.display()))?;
        let mut cfg: NexusMountConfig = serde_json::from_str(&raw)
            .with_context(|| format!("parsing mount config {}", path.display()))?;
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        if cfg.cache_dir.is_relative() {
            cfg.cache_dir = base.join(&cfg.cache_dir);
        }
        if cfg.journal_path.is_relative() {
            cfg.journal_path = base.join(&cfg.journal_path);
        }
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<()> {
        if self.workspace_id.trim().is_empty() {
            anyhow::bail!("workspace_id is required");
        }
        if !self.mountpoint.is_absolute() {
            anyhow::bail!("mountpoint must be absolute: {}", self.mountpoint.display());
        }
        if self.region_url.trim().is_empty() {
            anyhow::bail!("region_url is required");
        }
        Ok(())
    }

    /// Read the current bearer token, if the daemon has written one.
    pub fn read_token(&self) -> Result<Option<String>> {
        match std::fs::read_to_string(&self.token_path) {
            Ok(t) => {
                let t = t.trim().to_string();
                Ok(if t.is_empty() { None } else { Some(t) })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading token {}", self.token_path.display())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_config(dir: &Path, json: &str) -> PathBuf {
        let p = dir.join("session.helper.json");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(json.as_bytes()).unwrap();
        p
    }

    #[test]
    fn parses_the_daemon_shape() {
        let dir = tempfile::tempdir().unwrap();
        let json = format!(
            r#"{{
              "mountpoint": "{mp}",
              "workspace_id": "w1",
              "remote_folder_id": "clients",
              "remote_folder_path": "/Projects/Clients",
              "read_only": true,
              "cache_dir": "cache/x",
              "journal_path": "cache/x.journal.jsonl",
              "region_url": "https://region.test",
              "token_path": "x.token",
              "volume_name": "Nexus"
            }}"#,
            mp = dir.path().join("mnt").display(),
        );
        let path = write_config(dir.path(), &json);
        let cfg = NexusMountConfig::load(&path).unwrap();
        assert_eq!(cfg.workspace_id, "w1");
        assert_eq!(cfg.remote_folder_id.as_deref(), Some("clients"));
        assert!(cfg.read_only);
        // Relative cache/journal resolve against the config directory.
        assert!(cfg.cache_dir.starts_with(dir.path()));
        assert!(cfg.journal_path.starts_with(dir.path()));
    }

    #[test]
    fn rejects_a_relative_mountpoint() {
        let dir = tempfile::tempdir().unwrap();
        let json = r#"{
          "mountpoint": "relative/dir",
          "workspace_id": "w1",
          "cache_dir": "c",
          "journal_path": "c.j",
          "region_url": "https://region.test",
          "token_path": "t"
        }"#;
        let path = write_config(dir.path(), json);
        assert!(NexusMountConfig::load(&path).is_err());
    }

    #[test]
    fn missing_token_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let json = format!(
            r#"{{
              "mountpoint": "{mp}",
              "workspace_id": "w1",
              "cache_dir": "c",
              "journal_path": "c.j",
              "region_url": "https://region.test",
              "token_path": "{tok}"
            }}"#,
            mp = dir.path().join("mnt").display(),
            tok = dir.path().join("missing.token").display(),
        );
        let path = write_config(dir.path(), &json);
        let cfg = NexusMountConfig::load(&path).unwrap();
        assert!(cfg.read_token().unwrap().is_none());
    }
}
