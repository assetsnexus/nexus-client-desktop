//! Region node client for the mount helper.
//!
//! The helper never sees object-store credentials. Every read is a short-TTL
//! single-object presign (`anx.storage.presign.get`), and every write goes
//! through the region's file commands. This mirrors the Electron daemon's
//! contract so the two delivery modes behave identically.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// One remote file as returned by `anx.storage.bucket.list-files`.
#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub file_id: String,
    pub name: String,
    pub folder_id: Option<String>,
    pub size_bytes: u64,
    pub revision_no: Option<u64>,
}

/// One remote folder as returned by `anx.storage.workspace.folder.list`.
#[derive(Debug, Clone)]
pub struct RemoteFolder {
    pub folder_id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

/// Minimal command envelope matching the region's `/command` protocol.
#[derive(Debug, Serialize)]
struct CommandEnvelope<'a> {
    command: &'a str,
    #[serde(rename = "requestId")]
    request_id: String,
    payload: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<serde_json::Value>,
    #[serde(rename = "responseExpected")]
    response_expected: bool,
    timestamp: String,
}

#[derive(Debug, Deserialize)]
struct RegionResponse {
    #[serde(default, rename = "responseCode")]
    response_code: u16,
    #[serde(default, rename = "responseObject")]
    response_object: serde_json::Value,
    #[serde(default)]
    message: Option<String>,
}

pub struct RegionClient {
    base_url: String,
    token: String,
}

impl RegionClient {
    pub fn new(base_url: &str, token: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// A fresh agent per request. Pooled keep-alive connections proved flaky
    /// against the region (a reused socket can hang until the read timeout), and
    /// a mount helper issues far too few requests for pooling to matter.
    fn agent(&self) -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .build()
    }

    /// Send one command and return its `responseObject`.
    fn send(&self, command: &str, payload: serde_json::Value) -> Result<serde_json::Value> {
        let envelope = CommandEnvelope {
            command,
            request_id: format!("mount-{}-{}", command, uuid_like()),
            payload,
            identity: None,
            response_expected: true,
            timestamp: iso_now(),
        };
        let url = format!("{}/command", self.base_url);
        let body = self
            .agent()
            .post(&url)
            .set("content-type", "application/json")
            .set("authorization", &format!("Bearer {}", self.token))
            .send_json(serde_json::to_value(&envelope)?);

        let resp = match body {
            Ok(r) => r,
            // The region returns 4xx/5xx with a JSON body we still need to read.
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(anyhow::anyhow!("region request failed: {e}")),
        };
        let parsed: RegionResponse = resp
            .into_json()
            .context("decoding region response")?;
        if !(200..300).contains(&parsed.response_code) {
            anyhow::bail!(
                "region rejected {command} ({}): {}",
                parsed.response_code,
                parsed.message.unwrap_or_default()
            );
        }
        Ok(parsed.response_object)
    }

    /// List every folder in a workspace (one call, full tree).
    pub fn list_folders(&self, workspace_id: &str) -> Result<Vec<RemoteFolder>> {
        let obj = self.send(
            "anx.storage.workspace.folder.list",
            serde_json::json!({ "workspaceId": workspace_id }),
        )?;
        let items = obj
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(items
            .iter()
            .map(|it| RemoteFolder {
                folder_id: it
                    .get("_id")
                    .or_else(|| it.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name: it.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                parent_id: it
                    .get("parentFolderId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
            .collect())
    }

    /// Map every folder id to its record (for relative-path reconstruction).
    pub fn folder_index(&self, workspace_id: &str) -> Result<HashMap<String, RemoteFolder>> {
        Ok(self
            .list_folders(workspace_id)?
            .into_iter()
            .map(|f| (f.folder_id.clone(), f))
            .collect())
    }

    /// List every file in a workspace, newest-first, following the cursor.
    pub fn list_files(&self, workspace_id: &str) -> Result<Vec<RemoteFile>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let mut payload = serde_json::json!({ "workspaceId": workspace_id, "limit": 500 });
            if let Some(c) = &cursor {
                payload["cursor"] = serde_json::Value::String(c.clone());
            }
            let obj = self.send("anx.storage.bucket.list-files", payload)?;
            let items = obj
                .get("items")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for it in items {
                out.push(parse_remote_file(&it));
            }
            cursor = obj
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// Fetch a file's bytes via a single-object presign.
    pub fn download(&self, file_id: &str) -> Result<Vec<u8>> {
        let obj = self.send("anx.storage.presign.get", serde_json::json!({ "fileId": file_id }))?;
        let url = obj
            .get("url")
            .and_then(|v| v.as_str())
            .context("presign response had no url")?;
        let mut buf = Vec::new();
        self.agent()
            .get(url)
            .call()
            .context("downloading presigned object")?
            .into_reader()
            .read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Fetch just a bounded window of a file (used to hydrate a read a chunk at
    /// a time). Falls back to a full download when the region has no range.
    #[allow(dead_code)]
    pub fn download_range(&self, file_id: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
        let obj = self.send("anx.storage.presign.get", serde_json::json!({ "fileId": file_id }))?;
        let url = obj
            .get("url")
            .and_then(|v| v.as_str())
            .context("presign response had no url")?;
        let end = offset + len - 1;
        let resp = self
            .agent()
            .get(url)
            .set("range", &format!("bytes={offset}-{end}"))
            .call();
        let mut buf = Vec::new();
        match resp {
            Ok(r) => {
                r.into_reader().read_to_end(&mut buf)?;
            }
            Err(ureq::Error::Status(_, r)) => {
                r.into_reader().read_to_end(&mut buf)?;
            }
            Err(e) => return Err(anyhow::anyhow!("range download failed: {e}")),
        }
        Ok(buf)
    }

    /// Delete a remote file (trash) by file id.
    pub fn delete(&self, file_id: &str) -> Result<()> {
        self.send("anx.storage.bucket.trash-file", serde_json::json!({ "fileId": file_id }))?;
        Ok(())
    }

    /// Delete by relative path: resolve the file id from the workspace listing.
    pub fn delete_path(&self, workspace_id: &str, rel_path: &str) -> Result<()> {
        let target = rel_path.rsplit('/').next().unwrap_or(rel_path).to_string();
        let files = self.list_files(workspace_id)?;
        if let Some(f) = files.iter().find(|f| f.name == target) {
            self.delete(&f.file_id)
        } else {
            Ok(()) // already gone
        }
    }

    /// Upload bytes for `rel_path`, mirroring the storage-browser client's
    /// capability fallback: when `upload-init` reports `presignPut`, PUT to the
    /// signed URL and finalize with `anx.file.upload-complete-presign`;
    /// otherwise send base64 via `anx.file.upload-complete`.
    pub fn upload_file(
        &self,
        workspace_id: &str,
        folder_id: Option<&str>,
        rel_path: &str,
        bytes: &[u8],
    ) -> Result<()> {
        let name = rel_path.rsplit('/').next().unwrap_or(rel_path).to_string();
        let existing = self
            .list_files(workspace_id)?
            .into_iter()
            .find(|f| f.name == name);

        let mut init_payload = serde_json::json!({
            "originalName": name,
            "contentType": "application/octet-stream",
            "sizeBytes": bytes.len(),
            "workspaceId": workspace_id,
        });
        if let Some(folder) = folder_id {
            init_payload["folderId"] = serde_json::Value::String(folder.to_string());
        }
        let init = self.send("anx.file.upload-init", init_payload)?;
        let file_id = init
            .get("fileId")
            .and_then(|v| v.as_str())
            .context("upload-init returned no fileId")?
            .to_string();
        let presign_put = init.get("presignPut").and_then(|v| v.as_bool()).unwrap_or(false);
        let presign_url = init
            .get("presignUrl")
            .or_else(|| init.get("url"))
            .and_then(|v| v.as_str())
            .map(str::to_string);

        if presign_put {
            let url = presign_url.context("upload-init said presignPut but gave no url")?;
            self.agent()
                .put(&url)
                .set("content-type", "application/octet-stream")
                .send_bytes(bytes)
                .context("presigned put failed")?;
            self.send(
                "anx.file.upload-complete-presign",
                serde_json::json!({
                    "fileId": file_id,
                    "sizeBytes": bytes.len(),
                    "contentType": "application/octet-stream",
                }),
            )?;
        } else {
            self.send(
                "anx.file.upload-complete",
                serde_json::json!({
                    "fileId": file_id,
                    "base64Data": base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        bytes,
                    ),
                }),
            )?;
        }

        // If we replaced an existing object, supersede it so only one remote
        // file carries this name (best-effort: a failure here is not fatal).
        if let Some(prev) = existing {
            if prev.file_id != file_id {
                let _ = self.delete(&prev.file_id);
            }
        }
        Ok(())
    }

    /// Current remote revision for a file id (optimistic concurrency).
    #[allow(dead_code)]
    pub fn revision_of_id(&self, file_id: &str) -> Result<Option<u64>> {
        let obj = self.send("anx.file.get", serde_json::json!({ "fileId": file_id }))?;
        Ok(obj.get("revisionNo").and_then(|v| v.as_u64()))
    }

    /// Current remote revision for a path (resolved via the workspace listing).
    pub fn revision_of(&self, workspace_id: &str, rel_path: &str) -> Result<Option<u64>> {
        let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
        let files = self.list_files(workspace_id)?;
        Ok(files.iter().find(|f| f.name == name).and_then(|f| f.revision_no))
    }
}

fn parse_remote_file(it: &serde_json::Value) -> RemoteFile {
    RemoteFile {
        file_id: it
            .get("_id")
            .or_else(|| it.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        name: it
            .get("originalName")
            .or_else(|| it.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        folder_id: it.get("folderId").and_then(|v| v.as_str()).map(str::to_string),
        size_bytes: it.get("sizeBytes").and_then(|v| v.as_u64()).unwrap_or(0),
        revision_no: it.get("revisionNo").and_then(|v| v.as_u64()),
    }
}

/// Map files under the bound folder (or the whole bucket when `target` is
/// `None`) to their path relative to that folder, using the folder parent chain.
pub fn index_relative(
    files: &[RemoteFile],
    folders: &HashMap<String, RemoteFolder>,
    target: &Option<String>,
) -> HashMap<String, RemoteFile> {
    let mut out = HashMap::new();
    for f in files {
        if let Some(rel) = relative_path(f.folder_id.as_deref(), target.as_deref(), folders) {
            let rel = if rel.is_empty() {
                f.name.clone()
            } else {
                format!("{rel}/{}", f.name)
            };
            out.insert(rel, f.clone());
        }
    }
    out
}

/// Path of a folder relative to `target`, or `None` if it is not a descendant.
/// * `target = Some(id)` — stop when the chain reaches `id` (empty string means
///   the folder *is* the target).
/// * `target = None` — the whole workspace is mounted, so walk all the way to
///   the root, giving nested files their real sub-paths.
fn relative_path(
    folder_id: Option<&str>,
    target: Option<&str>,
    folders: &HashMap<String, RemoteFolder>,
) -> Option<String> {
    let mut names: Vec<String> = Vec::new();
    let mut cur = folder_id.map(str::to_string);
    let mut guard = std::collections::HashSet::new();
    while let Some(id) = cur {
        if Some(id.as_str()) == target {
            names.reverse();
            return Some(names.join("/"));
        }
        if !guard.insert(id.clone()) {
            return None; // cycle
        }
        let folder = match folders.get(&id) {
            Some(f) => f,
            // An unknown folder can still be a descendant when we are not
            // filtering; skip it rather than dropping the file.
            None if target.is_none() => break,
            None => return None,
        };
        names.push(folder.name.clone());
        cur = folder.parent_id.clone();
    }
    if target.is_none() {
        names.reverse();
        Some(names.join("/"))
    } else {
        None
    }
}

/// A monotonic-ish request id suffix without pulling in a uuid crate.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn iso_now() -> String {
    // RFC3339-ish; the region only uses this for ordering/audit.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, name: &str, folder: Option<&str>) -> RemoteFile {
        RemoteFile {
            file_id: id.into(),
            name: name.into(),
            folder_id: folder.map(str::to_string),
            size_bytes: 1,
            revision_no: Some(1),
        }
    }

    fn folder(id: &str, name: &str, parent: Option<&str>) -> RemoteFolder {
        RemoteFolder {
            folder_id: id.into(),
            name: name.into(),
            parent_id: parent.map(str::to_string),
        }
    }

    #[test]
    fn index_relative_honours_the_folder_chain() {
        let folders = HashMap::from([
            ("root".to_string(), folder("root", "Projects", None)),
            ("clients".to_string(), folder("clients", "Clients", Some("root"))),
            ("deep".to_string(), folder("deep", "2026", Some("clients"))),
        ]);

        let files = vec![
            mk("f1", "a.txt", Some("clients")),
            mk("f2", "b.txt", Some("deep")),
            mk("f3", "out.txt", None),
        ];
        let idx = index_relative(&files, &folders, &Some("clients".to_string()));
        // A file at the bound folder maps to its bare name...
        assert!(idx.contains_key("a.txt"));
        // ...and a nested one keeps its sub-path.
        assert!(idx.contains_key("2026/b.txt"));
        assert!(!idx.contains_key("out.txt"));
    }

    #[test]
    fn index_relative_root_includes_everything() {
        let folders = HashMap::from([("root".to_string(), folder("root", "Projects", None))]);
        let files = vec![
            mk("f1", "a.txt", None),
            mk("f2", "b.txt", Some("root")),
        ];
        let idx = index_relative(&files, &folders, &None);
        assert!(idx.contains_key("a.txt"));
        assert!(idx.contains_key("Projects/b.txt"));
    }

    #[test]
    fn parses_a_file_row() {
        let row = serde_json::json!({
            "_id": "f1", "originalName": "a.txt", "folderId": "clients",
            "sizeBytes": 12, "revisionNo": 3
        });
        let f = parse_remote_file(&row);
        assert_eq!(f.file_id, "f1");
        assert_eq!(f.name, "a.txt");
        assert_eq!(f.size_bytes, 12);
        assert_eq!(f.revision_no, Some(3));
    }
}
