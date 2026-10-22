//! `fuser::Filesystem` adapter over the pure [`Tree`].
//!
//! Reads hydrate missing content into the cache from the region (presign-only);
//! writes go to the cache immediately and append a write-back journal entry so
//! the region is caught up on flush. `read_only` sessions reject every mutation
//! with `EROFS`, matching the daemon's mode.

use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use fuser::{
    FileAttr, FileType, Filesystem, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyWrite, Request,
};
use parking_lot::Mutex;

use crate::client::RegionClient;
use crate::client::RemoteFolder;
use crate::config::NexusMountConfig;
use crate::journal::Journal;
use crate::tree::{Node, NodeKind, Tree};

const TTL: Duration = Duration::from_secs(1);
const BLOCK: u64 = 512;

/// Shared, thread-safe helper state (fuser may call from one thread today but
/// this keeps us correct if it ever parallelizes).
pub struct MountState {
    pub cfg: NexusMountConfig,
    pub tree: Mutex<Tree>,
    pub client: RegionClient,
    pub journal: Journal,
    /// Remote folder id -> folder record, for path reconstruction.
    #[allow(dead_code)]
    pub folders: std::collections::HashMap<String, RemoteFolder>,
    #[allow(dead_code)]
    pub uid: u32,
    #[allow(dead_code)]
    pub gid: u32,
}

impl MountState {
    pub fn cache_file(&self, node: &Node) -> Option<PathBuf> {
        if node.kind != NodeKind::File {
            return None;
        }
        let rel = self.tree.lock().rel_path(node.ino);
        crate::journal::cache_path(&self.cfg.cache_dir, &rel).ok()
    }

    /// Ensure the cached bytes for a file exist, downloading them if not.
    ///
    /// A file created locally has no remote id yet — its content lives only in
    /// the cache until the journal replay creates it upstream, so we simply
    /// materialize an empty file instead of trying to download.
    pub fn hydrate(&self, node: &Node) -> anyhow::Result<PathBuf> {
        let path = self
            .cache_file(node)
            .ok_or_else(|| anyhow::anyhow!("not a file"))?;
        if path.exists() {
            return Ok(path);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let Some(file_id) = &node.file_id else {
            fs::write(&path, b"")?;
            return Ok(path);
        };
        let bytes = self.client.download(file_id)?;
        fs::write(&path, &bytes)?;
        Ok(path)
    }
}

pub struct NexusFs {
    state: MountState,
}

impl NexusFs {
    pub fn new(state: MountState) -> Self {
        Self { state }
    }
}

fn attr_of(state: &MountState, node: &Node) -> FileAttr {
    let kind = match node.kind {
        NodeKind::Dir => FileType::Directory,
        NodeKind::File => FileType::RegularFile,
    };
    FileAttr {
        ino: node.ino,
        size: node.size,
        blocks: (node.size + BLOCK - 1) / BLOCK,
        atime: node.mtime,
        mtime: node.mtime,
        ctime: node.mtime,
        crtime: node.mtime,
        kind,
        perm: node.mode,
        nlink: if node.kind == NodeKind::Dir { 2 } else { 1 },
        uid: state.uid,
        gid: state.gid,
        rdev: 0,
        blksize: BLOCK as u32,
        flags: 0,
    }
}

impl Filesystem for NexusFs {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let tree = self.state.tree.lock();
        match tree.lookup(parent, &name.to_string_lossy()) {
            Some(node) => reply.entry(&TTL, &attr_of(&self.state, node), 0),
            None => reply.error(libc::ENOENT),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyAttr) {
        let tree = self.state.tree.lock();
        match tree.get(ino) {
            Some(node) => reply.attr(&TTL, &attr_of(&self.state, node)),
            None => reply.error(libc::ENOENT),
        }
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyData,
    ) {
        let node = match self.state.tree.lock().get(ino).cloned() {
            Some(n) => n,
            None => return reply.error(libc::ENOENT),
        };
        let path = match self.state.hydrate(&node) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("hydrate {ino} failed: {e}");
                return reply.error(libc::EIO);
            }
        };
        let mut f = match fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => return reply.error(libc::EIO),
        };
        if f.seek(SeekFrom::Start(offset.max(0) as u64)).is_err() {
            return reply.error(libc::EIO);
        }
        let mut buf = vec![0u8; size as usize];
        let read = f.read(&mut buf).unwrap_or(0);
        buf.truncate(read);
        reply.data(&buf);
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let tree = self.state.tree.lock();
        let Some(dir) = tree.get(ino) else {
            return reply.error(libc::ENOENT);
        };
        let mut entries: Vec<(u64, FileType, String)> = vec![
            (ino, FileType::Directory, ".".to_string()),
            (dir.parent, FileType::Directory, "..".to_string()),
        ];
        for node in tree.children_of(ino) {
            let kind = match node.kind {
                NodeKind::Dir => FileType::Directory,
                NodeKind::File => FileType::RegularFile,
            };
            entries.push((node.ino, kind, node.name.clone()));
        }
        for (i, (child, kind, name)) in entries.into_iter().enumerate().skip(offset as usize) {
            if reply.add(child, (i + 1) as i64, kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&mut self, _req: &Request<'_>, ino: u64, _flags: i32, reply: ReplyOpen) {
        if self.state.tree.lock().get(ino).is_some() {
            reply.opened(ino, 0);
        } else {
            reply.error(libc::ENOENT);
        }
    }

    fn write(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyWrite,
    ) {
        if self.state.cfg.read_only {
            return reply.error(libc::EROFS);
        }
        let node = match self.state.tree.lock().get(ino).cloned() {
            Some(n) => n,
            None => return reply.error(libc::ENOENT),
        };
        let path = match self.state.hydrate(&node) {
            Ok(p) => p,
            Err(_) => return reply.error(libc::EIO),
        };
        let mut f = match fs::OpenOptions::new().write(true).open(&path) {
            Ok(f) => f,
            Err(_) => return reply.error(libc::EIO),
        };
        if f.seek(SeekFrom::Start(offset.max(0) as u64)).is_err() || f.write_all(data).is_err() {
            return reply.error(libc::EIO);
        }
        let _ = f.sync_all();
        // Journal the mutation with the revision we based it on.
        let rel = self.state.tree.lock().rel_path(ino);
        let _ = self.state.journal.record_write(&rel, data, node.file_id.clone(), node.revision);
        // Grow the size if we wrote past the end.
        let new_size = (offset.max(0) as u64 + data.len() as u64).max(node.size);
        {
            let mut tree = self.state.tree.lock();
            if let Some(n) = tree.get(ino).cloned() {
                let _ = tree.upsert_file(&rel, n.file_id.clone(), new_size, n.revision);
            }
        }
        reply.written(data.len() as u32);
    }

    fn create(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        if self.state.cfg.read_only {
            return reply.error(libc::EROFS);
        }
        let name = name.to_string_lossy().to_string();
        let (ino, rel) = {
            let mut tree = self.state.tree.lock();
            let rel = match tree.get(parent) {
                Some(p) => {
                    let base = tree.rel_path(p.ino);
                    if base.is_empty() {
                        name.clone()
                    } else {
                        format!("{base}/{name}")
                    }
                }
                None => return reply.error(libc::ENOENT),
            };
            (tree.upsert_file(&rel, None, 0, None), rel)
        };
        if let Ok(path) = crate::journal::cache_path(&self.state.cfg.cache_dir, &rel) {
            if let Some(dir) = path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::File::create(&path);
        }
        // Note the new file so the replay uploads it; its content arrives with
        // the following write(s), not here.
        let _ = self.state.journal.record_write(&rel, &[], None, None);
        let node = self.state.tree.lock().get(ino).cloned().unwrap();
        reply.created(&TTL, &attr_of(&self.state, &node), 0, ino, 0);
    }

    fn mkdir(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        if self.state.cfg.read_only {
            return reply.error(libc::EROFS);
        }
        let name = name.to_string_lossy().to_string();
        let (ino, rel) = {
            let mut tree = self.state.tree.lock();
            let base = match tree.get(parent) {
                Some(p) => tree.rel_path(p.ino),
                None => return reply.error(libc::ENOENT),
            };
            let rel = if base.is_empty() {
                name.clone()
            } else {
                format!("{base}/{name}")
            };
            (tree.ensure_dir(&rel), rel)
        };
        let _ = self.state.journal.record_mkdir(&rel);
        let node = self.state.tree.lock().get(ino).cloned().unwrap();
        reply.entry(&TTL, &attr_of(&self.state, &node), 0);
    }

    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        if self.state.cfg.read_only {
            return reply.error(libc::EROFS);
        }
        let name = name.to_string_lossy().to_string();
        let mut tree = self.state.tree.lock();
        let Some(node) = tree.lookup(parent, &name).cloned() else {
            return reply.error(libc::ENOENT);
        };
        if node.kind == NodeKind::Dir {
            return reply.error(libc::EISDIR);
        }
        let rel = tree.rel_path(node.ino);
        tree.remove(node.ino);
        drop(tree);
        if let Ok(path) = crate::journal::cache_path(&self.state.cfg.cache_dir, &rel) {
            let _ = fs::remove_file(path);
        }
        let _ = self.state.journal.record_delete(&rel, node.file_id.clone(), node.revision);
        reply.ok();
    }

    fn setattr(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<fuser::TimeOrNow>,
        _mtime: Option<fuser::TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<u64>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<u32>,
        reply: ReplyAttr,
    ) {
        if let Some(new_size) = size {
            if self.state.cfg.read_only {
                return reply.error(libc::EROFS);
            }
            let node = match self.state.tree.lock().get(ino).cloned() {
                Some(n) => n,
                None => return reply.error(libc::ENOENT),
            };
            if let Ok(path) = self.state.hydrate(&node) {
                if let Ok(f) = fs::OpenOptions::new().write(true).open(&path) {
                    let _ = f.set_len(new_size);
                }
            }
            let rel = self.state.tree.lock().rel_path(ino);
            let _ = self.state.journal.record_write(&rel, &[], node.file_id.clone(), node.revision);
            let mut tree = self.state.tree.lock();
            if let Some(n) = tree.get(ino).cloned() {
                let _ = tree.upsert_file(&rel, n.file_id.clone(), new_size, n.revision);
            }
        }
        let tree = self.state.tree.lock();
        match tree.get(ino) {
            Some(node) => reply.attr(&TTL, &attr_of(&self.state, node)),
            None => reply.error(libc::ENOENT),
        }
    }

    fn opendir(&mut self, _req: &Request<'_>, _ino: u64, _flags: i32, reply: ReplyOpen) {
        reply.opened(0, 0);
    }

    fn releasedir(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        _fh: u64,
        _flags: i32,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn flush(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _lock_owner: u64, reply: ReplyEmpty) {
        reply.ok();
    }

    fn release(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        _fh: u64,
        _flags: i32,
        _lock_owner: Option<u64>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn statfs(&mut self, _req: &Request<'_>, _ino: u64, reply: fuser::ReplyStatfs) {
        // Report a generous fixed geometry; the real quota is enforced by the region.
        reply.statfs(0, 0, 0, 0, 0, BLOCK as u32, 255, BLOCK as u32);
    }
}

/// Mount the filesystem and block until unmounted.
pub fn run(state: MountState) -> anyhow::Result<()> {
    let mountpoint = state.cfg.mountpoint.clone();
    let mut options = vec![
        fuser::MountOption::FSName(state.cfg.volume_name.clone()),
        fuser::MountOption::Subtype("nexus".to_string()),
        fuser::MountOption::DefaultPermissions,
    ];
    // `AutoUnmount` implies `allow_other`, which the kernel only permits when
    // `user_allow_other` is enabled in /etc/fuse.conf. Only ask for it when the
    // host allows it, otherwise mount plainly (the daemon unmounts on stop).
    if user_allow_other() {
        options.push(fuser::MountOption::AutoUnmount);
    }
    if state.cfg.read_only {
        tracing::info!("mounted {} read-only", mountpoint.display());
    }
    let fs = NexusFs::new(state);
    fuser::mount2(fs, &mountpoint, &options)?;
    Ok(())
}

/// Whether the host permits `allow_other` (needed for `AutoUnmount`).
fn user_allow_other() -> bool {
    let Ok(conf) = std::fs::read_to_string("/etc/fuse.conf") else {
        return false;
    };
    conf.lines()
        .map(str::trim)
        .any(|l| l == "user_allow_other" && !l.starts_with('#'))
}
