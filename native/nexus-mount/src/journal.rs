//! Content cache + offline write-back journal.
//!
//! The cache is a plain directory tree mirroring the mounted sub-directory, so
//! a read is a local file open after the first hydration. The journal is an
//! append-only JSONL file the daemon and helper share: the helper appends each
//! local mutation, and the daemon (or the helper itself on reconnect) replays it
//! against the region in enqueue order, carrying the base revision so a stale
//! write fails instead of clobbering.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JournalOp {
    Write,
    Delete,
    Mkdir,
}

/// One queued mutation. Field names match `mount-plan.ts` `JournalEntry`;
/// `fileId` is an addition the helper uses to resolve optimistic concurrency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    #[serde(rename = "bindingId")]
    pub binding_id: String,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub op: JournalOp,
    #[serde(rename = "contentBase64", skip_serializing_if = "Option::is_none")]
    pub content_base64: Option<String>,
    #[serde(rename = "fileId", default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(rename = "baseRevision", default)]
    pub base_revision: Option<u64>,
    #[serde(rename = "enqueuedAt")]
    pub enqueued_at: String,
}

/// A write-back journal backed by a JSONL file, append-only and fsync'd.
pub struct Journal {
    path: PathBuf,
    binding_id: String,
    file: Mutex<File>,
}

impl Journal {
    pub fn open(path: &Path, binding_id: &str) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating journal dir {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("opening journal {}", path.display()))?;
        Ok(Self {
            path: path.to_path_buf(),
            binding_id: binding_id.to_string(),
            file: Mutex::new(file),
        })
    }

    fn append(&self, entry: &JournalEntry) -> Result<()> {
        let line = serde_json::to_string(entry)?;
        let mut f = self.file.lock();
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        Ok(())
    }

    pub fn record_write(
        &self,
        rel_path: &str,
        bytes: &[u8],
        file_id: Option<String>,
        base_revision: Option<u64>,
    ) -> Result<()> {
        self.append(&JournalEntry {
            binding_id: self.binding_id.clone(),
            rel_path: rel_path.to_string(),
            op: JournalOp::Write,
            content_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            file_id,
            base_revision,
            enqueued_at: now_iso(),
        })
    }

    pub fn record_delete(&self, rel_path: &str, file_id: Option<String>, base_revision: Option<u64>) -> Result<()> {
        self.append(&JournalEntry {
            binding_id: self.binding_id.clone(),
            rel_path: rel_path.to_string(),
            op: JournalOp::Delete,
            content_base64: None,
            file_id,
            base_revision,
            enqueued_at: now_iso(),
        })
    }

    pub fn record_mkdir(&self, rel_path: &str) -> Result<()> {
        self.append(&JournalEntry {
            binding_id: self.binding_id.clone(),
            rel_path: rel_path.to_string(),
            op: JournalOp::Mkdir,
            content_base64: None,
            file_id: None,
            base_revision: None,
            enqueued_at: now_iso(),
        })
    }

    /// Read the pending entries in replay order (oldest first).
    pub fn pending(&self) -> Result<Vec<JournalEntry>> {
        let file = File::open(&self.path)?;
        let mut out = Vec::new();
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            // A torn final line (crash mid-append) is skipped, not fatal.
            match serde_json::from_str::<JournalEntry>(&line) {
                Ok(e) => out.push(e),
                Err(_) => continue,
            }
        }
        out.sort_by(|a, b| a.enqueued_at.cmp(&b.enqueued_at));
        Ok(out)
    }

    /// Drop every pending entry once replay has committed them.
    pub fn clear(&self) -> Result<()> {
        let f = self.file.lock();
        f.set_len(0)?;
        f.sync_all()?;
        Ok(())
    }
}

/// Ensure a cache directory exists and return a path under it for `rel`.
pub fn cache_path(cache_dir: &Path, rel: &str) -> Result<PathBuf> {
    let safe = sanitize_rel(rel)?;
    Ok(cache_dir.join(safe))
}

/// Reject traversal and absolute paths inside the mounted tree.
pub fn sanitize_rel(rel: &str) -> Result<PathBuf> {
    if rel.contains('\0') {
        anyhow::bail!("null byte in path");
    }
    let mut out = PathBuf::new();
    for part in rel.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => anyhow::bail!("path traversal in {rel:?}"),
            p => out.push(p),
        }
    }
    if out.as_os_str().is_empty() {
        anyhow::bail!("empty relative path");
    }
    Ok(out)
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_round_trips_and_orders() {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::open(&dir.path().join("j.jsonl"), "b1").unwrap();
        j.record_write("a.txt", b"hello", Some("f1".into()), Some(2)).unwrap();
        j.record_delete("b.txt", Some("f2".into()), Some(3)).unwrap();
        j.record_mkdir("sub").unwrap();

        let pending = j.pending().unwrap();
        assert_eq!(pending.len(), 3);
        assert_eq!(pending[0].op, JournalOp::Write);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(pending[0].content_base64.as_ref().unwrap())
            .unwrap();
        assert_eq!(decoded, b"hello");

        j.clear().unwrap();
        assert!(j.pending().unwrap().is_empty());
    }

    #[test]
    fn journal_skips_a_torn_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("j.jsonl");
        let j = Journal::open(&path, "b1").unwrap();
        j.record_write("a.txt", b"x", None, None).unwrap();
        // Simulate a crash mid-append.
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"bindingId\":\"b1\",\"relPath\":").unwrap();
        assert_eq!(j.pending().unwrap().len(), 1);
    }

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize_rel("../etc/passwd").is_err());
        assert!(sanitize_rel("a/../../b").is_err());
        assert_eq!(sanitize_rel("a//b/./c").unwrap(), PathBuf::from("a/b/c"));
    }
}
