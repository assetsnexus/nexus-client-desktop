//! Pure in-memory directory model for the mounted tree.
//!
//! Kept free of any FUSE types so it is unit-testable and identical on every
//! platform. `fs.rs` adapts this to `fuser::Filesystem`; a Windows/WinFsp
//! backend would adapt the same model.

use std::collections::BTreeMap;
use std::time::SystemTime;

/// Root inode is always 1 (FUSE convention).
pub const ROOT_INO: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Dir,
    File,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub ino: u64,
    pub parent: u64,
    pub name: String,
    pub kind: NodeKind,
    /// Remote file id when this node is backed by a bucket object.
    pub file_id: Option<String>,
    /// Remote revision at the last hydration (for optimistic concurrency).
    pub revision: Option<u64>,
    pub size: u64,
    pub mode: u16,
    pub mtime: SystemTime,
}

impl Node {
    fn dir(ino: u64, parent: u64, name: impl Into<String>, mode: u16) -> Self {
        Self {
            ino,
            parent,
            name: name.into(),
            kind: NodeKind::Dir,
            file_id: None,
            revision: None,
            size: 0,
            mode,
            mtime: SystemTime::now(),
        }
    }

    fn file(ino: u64, parent: u64, name: impl Into<String>, mode: u16) -> Self {
        Self {
            ino,
            parent,
            name: name.into(),
            kind: NodeKind::File,
            file_id: None,
            revision: None,
            size: 0,
            mode,
            mtime: SystemTime::now(),
        }
    }
}

/// Directory mode: 0755, file mode: 0644 (umask is applied by the kernel).
pub const DIR_MODE: u16 = 0o755;
pub const FILE_MODE: u16 = 0o644;

#[derive(Debug, Default)]
pub struct Tree {    nodes: BTreeMap<u64, Node>,
    /// name -> ino within a parent directory.
    children: BTreeMap<u64, BTreeMap<String, u64>>,
    next_ino: u64,
}

impl Tree {
    pub fn new() -> Self {
        let mut t = Self {
            nodes: BTreeMap::new(),
            children: BTreeMap::new(),
            next_ino: ROOT_INO + 1,
        };
        t.nodes
            .insert(ROOT_INO, Node::dir(ROOT_INO, ROOT_INO, "", DIR_MODE));
        t.children.insert(ROOT_INO, BTreeMap::new());
        t
    }

    pub fn get(&self, ino: u64) -> Option<&Node> {
        self.nodes.get(&ino)
    }

    pub fn lookup(&self, parent: u64, name: &str) -> Option<&Node> {
        let ino = *self.children.get(&parent)?.get(name)?;
        self.nodes.get(&ino)
    }

    pub fn children_of(&self, parent: u64) -> Vec<&Node> {
        match self.children.get(&parent) {
            Some(kids) => kids.values().filter_map(|ino| self.nodes.get(ino)).collect(),
            None => Vec::new(),
        }
    }

    /// The relative slash path of a node from the root.
    pub fn rel_path(&self, ino: u64) -> String {
        let mut parts = Vec::new();
        let mut cur = ino;
        let mut guard = 0;
        while cur != ROOT_INO && guard < 4096 {
            match self.nodes.get(&cur) {
                Some(n) if !n.name.is_empty() => {
                    parts.push(n.name.clone());
                    cur = n.parent;
                }
                _ => break,
            }
            guard += 1;
        }
        parts.reverse();
        parts.join("/")
    }

    fn alloc_ino(&mut self) -> u64 {
        let ino = self.next_ino;
        self.next_ino += 1;
        ino
    }

    fn attach(&mut self, parent: u64, name: &str, ino: u64) {
        self.children
            .entry(parent)
            .or_default()
            .insert(name.to_string(), ino);
    }

    /// Ensure a directory exists at `rel` (creating ancestors), returning its ino.
    pub fn ensure_dir(&mut self, rel: &str) -> u64 {
        let mut cur = ROOT_INO;
        for part in rel.split('/').filter(|p| !p.is_empty() && *p != ".") {
            if let Some(existing) = self.children.get(&cur).and_then(|c| c.get(part)).copied() {
                cur = existing;
                continue;
            }
            let ino = self.alloc_ino();
            let node = Node::dir(ino, cur, part, DIR_MODE);
            self.nodes.insert(ino, node);
            self.attach(cur, part, ino);
            cur = ino;
        }
        cur
    }

    /// Insert or replace a file at `rel`, returning its ino. Creates parent dirs.
    pub fn upsert_file(
        &mut self,
        rel: &str,
        file_id: Option<String>,
        size: u64,
        revision: Option<u64>,
    ) -> u64 {
        let (parent_rel, name) = split_parent(rel);
        let parent = self.ensure_dir(&parent_rel);
        let existing = self.children.get(&parent).and_then(|c| c.get(&name)).copied();
        let ino = existing.unwrap_or_else(|| self.alloc_ino());
        let node = match existing.and_then(|i| self.nodes.get(&i)) {
            Some(n) if n.kind == NodeKind::File => {
                let mut n = n.clone();
                n.file_id = file_id.or(n.file_id);
                n.size = size;
                n.revision = revision;
                n.mtime = SystemTime::now();
                n
            }
            _ => {
                let mut n = Node::file(ino, parent, name.clone(), FILE_MODE);
                n.file_id = file_id;
                n.size = size;
                n.revision = revision;
                n
            }
        };
        self.nodes.insert(ino, node);
        self.attach(parent, &name, ino);
        ino
    }

    /// Remove a node (and, for directories, everything under it).
    pub fn remove(&mut self, ino: u64) -> bool {
        let Some(node) = self.nodes.get(&ino).cloned() else {
            return false;
        };
        if ino == ROOT_INO {
            return false;
        }
        // Depth-first detach of children (collect inos first to end the borrow).
        let child_inos: Vec<u64> = self.children_of(ino).iter().map(|n| n.ino).collect();
        for child_ino in child_inos {
            self.remove(child_ino);
        }
        self.children.remove(&ino);
        self.nodes.remove(&ino);
        if let Some(kids) = self.children.get_mut(&node.parent) {
            kids.remove(&node.name);
        }
        true
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

fn split_parent(rel: &str) -> (String, String) {
    let trimmed = rel.trim_matches('/');
    match trimmed.rsplit_once('/') {
        Some((parent, name)) => (parent.to_string(), name.to_string()),
        None => (String::new(), trimmed.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_exists() {
        let t = Tree::new();
        assert_eq!(t.get(ROOT_INO).unwrap().kind, NodeKind::Dir);
        assert!(t.lookup(ROOT_INO, "nope").is_none());
    }

    #[test]
    fn upsert_file_creates_ancestors_and_sets_rel_path() {
        let mut t = Tree::new();
        let ino = t.upsert_file("Projects/Clients/a.txt", Some("f1".into()), 12, Some(3));
        let node = t.get(ino).unwrap();
        assert_eq!(node.kind, NodeKind::File);
        assert_eq!(node.file_id.as_deref(), Some("f1"));
        assert_eq!(node.revision, Some(3));
        assert_eq!(t.rel_path(ino), "Projects/Clients/a.txt");
        // Ancestors are real directories.
        let clients = t.ensure_dir("Projects/Clients");
        assert_eq!(t.get(clients).unwrap().kind, NodeKind::Dir);
    }

    #[test]
    fn upsert_is_idempotent_for_a_path() {
        let mut t = Tree::new();
        let a = t.upsert_file("a.txt", Some("f1".into()), 1, Some(1));
        let b = t.upsert_file("a.txt", Some("f1".into()), 2, Some(2));
        assert_eq!(a, b);
        assert_eq!(t.get(a).unwrap().size, 2);
        assert_eq!(t.children_of(ROOT_INO).len(), 1);
    }

    #[test]
    fn remove_is_recursive() {
        let mut t = Tree::new();
        t.upsert_file("a/b/c.txt", None, 1, None);
        let a = t.ensure_dir("a");
        assert!(t.remove(a));
        assert!(t.lookup(ROOT_INO, "a").is_none());
        assert_eq!(t.len(), 1); // just root
    }

    #[test]
    fn remove_refuses_root() {
        let mut t = Tree::new();
        assert!(!t.remove(ROOT_INO));
    }

    #[test]
    fn children_of_lists_names() {
        let mut t = Tree::new();
        t.upsert_file("a.txt", None, 1, None);
        t.upsert_file("b.txt", None, 1, None);
        let mut names: Vec<_> = t.children_of(ROOT_INO).iter().map(|n| n.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
    }
}
