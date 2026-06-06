use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use rusqlite::{params, Connection};

use crate::workspace::FileEntry;

#[derive(Clone, Default)]
pub struct WorkspaceIndex {
    database_path: Arc<RwLock<Option<PathBuf>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceIndexError {
    #[error("workspace index is not initialized")]
    NotInitialized,
    #[error("workspace index lock poisoned")]
    LockPoisoned,
    #[error("workspace index io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("workspace index database error: {0}")]
    Database(#[from] rusqlite::Error),
}

impl WorkspaceIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_database_path(&self, path: PathBuf) -> Result<(), WorkspaceIndexError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let connection = open_database(&path)?;
        initialize_schema(&connection)?;
        drop(connection);

        *self
            .database_path
            .write()
            .map_err(|_| WorkspaceIndexError::LockPoisoned)? = Some(path);
        Ok(())
    }

    pub fn replace_root_entries(
        &self,
        root: &Path,
        entries: &[FileEntry],
    ) -> Result<(), WorkspaceIndexError> {
        let root_key = root_key(root);
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM workspace_entries WHERE root = ?1", [&root_key])?;
        transaction.execute(
            "DELETE FROM workspace_indexed_directories WHERE root = ?1",
            [&root_key],
        )?;
        insert_entries(&transaction, &root_key, entries)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn replace_directory_entries(
        &self,
        root: &Path,
        parent: &str,
        entries: &[FileEntry],
    ) -> Result<(), WorkspaceIndexError> {
        let root_key = root_key(root);
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if parent.is_empty() {
            transaction.execute(
                "DELETE FROM workspace_entries WHERE root = ?1 AND parent IS NULL",
                [&root_key],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM workspace_entries WHERE root = ?1 AND parent = ?2",
                params![root_key, parent],
            )?;
        }
        insert_entries(&transaction, &root_key, entries)?;
        mark_directory_indexed(&transaction, &root_key, parent)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_entries(
        &self,
        root: &Path,
        entries: &[FileEntry],
    ) -> Result<(), WorkspaceIndexError> {
        let root_key = root_key(root);
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        insert_entries(&transaction, &root_key, entries)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_path(&self, root: &Path, relative: &str) -> Result<(), WorkspaceIndexError> {
        let root_key = root_key(root);
        let connection = self.connection()?;
        let prefix = format!("{relative}/");
        connection.execute(
            "DELETE FROM workspace_entries
             WHERE root = ?1 AND (path = ?2 OR substr(path, 1, ?3) = ?4)",
            params![
                root_key,
                relative,
                i64::try_from(prefix.len()).unwrap_or(i64::MAX),
                prefix
            ],
        )?;
        connection.execute(
            "DELETE FROM workspace_indexed_directories
             WHERE root = ?1 AND (path = ?2 OR substr(path, 1, ?3) = ?4)",
            params![
                root_key,
                relative,
                i64::try_from(prefix.len()).unwrap_or(i64::MAX),
                prefix
            ],
        )?;
        Ok(())
    }

    pub fn search_files(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
    ) -> Result<Vec<FileEntry>, WorkspaceIndexError> {
        let root_key = root_key(root);
        let query = query.trim().to_lowercase();
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let connection = self.connection()?;
        let mut entries = Vec::new();

        if query.is_empty() {
            let mut statement = connection.prepare(
                "SELECT path, name, parent, is_dir, depth, size, modified_ms
                 FROM workspace_entries
                 WHERE root = ?1 AND is_dir = 0
                 ORDER BY lower(path), path
                 LIMIT ?2",
            )?;
            let rows = statement.query_map(params![root_key, limit], file_entry_from_row)?;
            for row in rows {
                entries.push(row?);
            }
            return Ok(entries);
        }

        let exact = query.as_str();
        let starts_with = format!("{}%", escape_like(&query));
        let contains = format!("%{}%", escape_like(&query));
        let mut statement = connection.prepare(
            "SELECT path, name, parent, is_dir, depth, size, modified_ms
             FROM workspace_entries
             WHERE root = ?1
                AND is_dir = 0
                AND (lower(path) LIKE ?2 ESCAPE '\\' OR lower(name) LIKE ?2 ESCAPE '\\')
             ORDER BY
                CASE
                    WHEN lower(name) = ?3 THEN 0
                    WHEN lower(path) = ?3 THEN 1
                    WHEN lower(name) LIKE ?4 ESCAPE '\\' THEN 2
                    WHEN lower(path) LIKE ?4 ESCAPE '\\' THEN 3
                    ELSE 4
                END,
                lower(path),
                path
             LIMIT ?5",
        )?;
        let rows = statement.query_map(
            params![root_key, contains, exact, starts_with, limit],
            file_entry_from_row,
        )?;
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    pub fn next_unindexed_directories(
        &self,
        root: &Path,
        limit: usize,
    ) -> Result<Vec<String>, WorkspaceIndexError> {
        let root_key = root_key(root);
        let connection = self.connection()?;
        let mut directories = Vec::new();

        if !directory_is_indexed(&connection, &root_key, "")? {
            return Ok(vec![String::new()]);
        }

        let mut statement = connection.prepare(
            "SELECT path
             FROM workspace_entries AS entry
             WHERE entry.root = ?1
                AND entry.is_dir = 1
                AND NOT EXISTS (
                    SELECT 1
                    FROM workspace_indexed_directories AS indexed
                    WHERE indexed.root = entry.root AND indexed.path = entry.path
                )
             ORDER BY entry.depth, lower(entry.path), entry.path
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![root_key, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| row.get::<_, String>(0),
        )?;
        for row in rows {
            if directories.len() >= limit {
                break;
            }
            directories.push(row?);
        }
        Ok(directories)
    }

    #[cfg(test)]
    pub fn entries_for_root(&self, root: &Path) -> Result<Vec<FileEntry>, WorkspaceIndexError> {
        let root_key = root_key(root);
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT path, name, parent, is_dir, depth, size, modified_ms
             FROM workspace_entries
             WHERE root = ?1
             ORDER BY lower(path), path",
        )?;
        let rows = statement.query_map([root_key], file_entry_from_row)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    fn connection(&self) -> Result<Connection, WorkspaceIndexError> {
        let path = self
            .database_path
            .read()
            .map_err(|_| WorkspaceIndexError::LockPoisoned)?
            .clone()
            .ok_or(WorkspaceIndexError::NotInitialized)?;
        open_database(&path)
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn open_database(path: &Path) -> Result<Connection, WorkspaceIndexError> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), WorkspaceIndexError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspace_entries (
            root TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            parent TEXT,
            is_dir INTEGER NOT NULL,
            depth INTEGER NOT NULL,
            size INTEGER NOT NULL,
            modified_ms INTEGER,
            indexed_at_ms INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
            PRIMARY KEY (root, path)
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_entries_parent
            ON workspace_entries(root, parent, lower(name), name);

        CREATE INDEX IF NOT EXISTS idx_workspace_entries_name
            ON workspace_entries(root, lower(name), name);

        CREATE TABLE IF NOT EXISTS workspace_indexed_directories (
            root TEXT NOT NULL,
            path TEXT NOT NULL,
            indexed_at_ms INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
            PRIMARY KEY (root, path)
        );
        ",
    )?;
    Ok(())
}

fn directory_is_indexed(
    connection: &Connection,
    root_key: &str,
    path: &str,
) -> Result<bool, WorkspaceIndexError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM workspace_indexed_directories
         WHERE root = ?1 AND path = ?2",
        params![root_key, path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn mark_directory_indexed(
    connection: &Connection,
    root_key: &str,
    path: &str,
) -> Result<(), WorkspaceIndexError> {
    connection.execute(
        "INSERT INTO workspace_indexed_directories (root, path)
         VALUES (?1, ?2)
         ON CONFLICT(root, path) DO UPDATE SET
            indexed_at_ms = unixepoch('subsec') * 1000",
        params![root_key, path],
    )?;
    Ok(())
}

fn insert_entries(
    connection: &Connection,
    root_key: &str,
    entries: &[FileEntry],
) -> Result<(), WorkspaceIndexError> {
    let mut statement = connection.prepare(
        "
        INSERT INTO workspace_entries
            (root, path, name, parent, is_dir, depth, size, modified_ms)
        VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(root, path) DO UPDATE SET
            name = excluded.name,
            parent = excluded.parent,
            is_dir = excluded.is_dir,
            depth = excluded.depth,
            size = excluded.size,
            modified_ms = excluded.modified_ms,
            indexed_at_ms = unixepoch('subsec') * 1000
        ",
    )?;

    for entry in entries {
        statement.execute(params![
            root_key,
            entry.path,
            entry.name,
            entry.parent,
            if entry.is_dir { 1_i64 } else { 0_i64 },
            i64::try_from(entry.depth).unwrap_or(i64::MAX),
            i64::try_from(entry.size).unwrap_or(i64::MAX),
            entry
                .modified_ms
                .and_then(|value| i64::try_from(value).ok()),
        ])?;
    }

    Ok(())
}

fn file_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileEntry> {
    let is_dir: i64 = row.get(3)?;
    let depth: i64 = row.get(4)?;
    let size: i64 = row.get(5)?;
    let modified_ms: Option<i64> = row.get(6)?;

    Ok(FileEntry {
        path: row.get(0)?,
        name: row.get(1)?,
        parent: row.get(2)?,
        is_dir: is_dir != 0,
        depth: usize::try_from(depth).unwrap_or(usize::MAX),
        size: u64::try_from(size).unwrap_or(u64::MAX),
        modified_ms: modified_ms.and_then(|value| u128::try_from(value).ok()),
    })
}

fn root_key(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn entry(path: &str, parent: Option<&str>, is_dir: bool) -> FileEntry {
        FileEntry {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            parent: parent.map(ToString::to_string),
            is_dir,
            depth: path.matches('/').count(),
            size: 0,
            modified_ms: Some(1),
        }
    }

    #[test]
    fn root_entries_are_replaced_without_leaving_stale_rows() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(
                dir.path(),
                &[entry("src", None, true), entry("old.txt", None, false)],
            )
            .unwrap();
        index
            .replace_root_entries(dir.path(), &[entry("src", None, true)])
            .unwrap();

        let entries = index.entries_for_root(dir.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src");
    }

    #[test]
    fn directory_entries_replace_only_that_parent() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(dir.path(), &[entry("src", None, true)])
            .unwrap();
        index
            .replace_directory_entries(
                dir.path(),
                "src",
                &[entry("src/main.rs", Some("src"), false)],
            )
            .unwrap();
        index
            .replace_directory_entries(
                dir.path(),
                "src",
                &[entry("src/lib.rs", Some("src"), false)],
            )
            .unwrap();

        let paths = index
            .entries_for_root(dir.path())
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["src", "src/lib.rs"]);
    }

    #[test]
    fn next_unindexed_directories_starts_at_root_then_walks_by_layer() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(
                dir.path(),
                &[entry("b", None, true), entry("a", None, true)],
            )
            .unwrap();

        assert_eq!(
            index.next_unindexed_directories(dir.path(), 3).unwrap(),
            vec![""]
        );

        index
            .replace_directory_entries(
                dir.path(),
                "",
                &[entry("b", None, true), entry("a", None, true)],
            )
            .unwrap();

        assert_eq!(
            index.next_unindexed_directories(dir.path(), 3).unwrap(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn replacing_root_entries_clears_indexed_directory_frontier() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_directory_entries(
                dir.path(),
                "",
                &[entry("src", None, true), entry("README.md", None, false)],
            )
            .unwrap();
        assert_eq!(
            index.next_unindexed_directories(dir.path(), 1).unwrap(),
            vec!["src"]
        );

        index
            .replace_root_entries(dir.path(), &[entry("src", None, true)])
            .unwrap();

        assert_eq!(
            index.next_unindexed_directories(dir.path(), 1).unwrap(),
            vec![""]
        );
    }

    #[test]
    fn remove_path_removes_indexed_subtrees() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(
                dir.path(),
                &[
                    entry("src", None, true),
                    entry("src/main.rs", Some("src"), false),
                    entry("README.md", None, false),
                ],
            )
            .unwrap();
        index
            .replace_directory_entries(
                dir.path(),
                "",
                &[entry("src", None, true), entry("README.md", None, false)],
            )
            .unwrap();
        index
            .replace_directory_entries(dir.path(), "src", &[entry("src/nested", Some("src"), true)])
            .unwrap();
        index
            .replace_directory_entries(
                dir.path(),
                "src/nested",
                &[entry("src/nested/file.rs", Some("src/nested"), false)],
            )
            .unwrap();
        index.remove_path(dir.path(), "src").unwrap();

        let entries = index.entries_for_root(dir.path()).unwrap();
        let unindexed_directories = index.next_unindexed_directories(dir.path(), 5).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "README.md");
        assert!(unindexed_directories.is_empty());
    }

    #[test]
    fn search_files_matches_indexed_file_paths_and_names() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(
                dir.path(),
                &[
                    entry("src", None, true),
                    entry("src/App.tsx", Some("src"), false),
                    entry("src/appWindow.ts", Some("src"), false),
                    entry("README.md", None, false),
                ],
            )
            .unwrap();

        let paths = index
            .search_files(dir.path(), "app", 10)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["src/App.tsx", "src/appWindow.ts"]);
    }

    #[test]
    fn search_files_respects_limit_and_excludes_directories() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(
                dir.path(),
                &[
                    entry("a", None, true),
                    entry("a/one.ts", Some("a"), false),
                    entry("a/two.ts", Some("a"), false),
                    entry("a/three.ts", Some("a"), false),
                ],
            )
            .unwrap();

        let paths = index
            .search_files(dir.path(), "", 2)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["a/one.ts", "a/three.ts"]);
    }

    #[test]
    fn search_files_escapes_like_wildcards() {
        let dir = tempdir().unwrap();
        let index = WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();

        index
            .replace_root_entries(
                dir.path(),
                &[
                    entry("100_percent.txt", None, false),
                    entry("100% literal.txt", None, false),
                    entry("100a literal.txt", None, false),
                ],
            )
            .unwrap();

        let paths = index
            .search_files(dir.path(), "100%", 10)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["100% literal.txt"]);
    }
}
