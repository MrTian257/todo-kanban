# project-library learnings

## Task: fix `DbState` missing `resources` field in test literals

The `resources: Vec<DbLibraryResource>` field (project library feature, SQLite v9) was added to
`DbState` in `src-tauri/core/src/models.rs`, breaking ALL `DbState` struct literals (production + test).

### Fixes applied
- `src-tauri/core/src/svc/db_cmds.rs` `seed_demo_state`: added `resources: vec![]` (production demo seed).
- `src-tauri/core/src/db/mod.rs` `#[cfg(test)]`: added `resources: vec![]` to **14** `DbState` literals
  (lines 380-584: save_and_load_roundtrip, seq_collision_converged, commit_dedup_global,
  manual_tag_preserved_on_seq_assign, duplicate_manual_tag_rejected, clear_tag_regenerates_from_seq,
  dangling_swimlane_fallback, diff_delete_removes_missing, fingerprint_changes_on_write, etc).
- `src-tauri/core/src/svc/attachments.rs` `seed()` test helper: added `resources: vec![]`.
- `src-tauri/mcp-server/src/bridge.rs` test `ai_markers_new_and_modified`: added `resources: vec![]`
  to both `DbState` literals.

### Required compile fixes (open_and_init already returned `(Connection, VersionReport)` at HEAD)
- `attachments.rs` tests did `let conn = db::open_and_init(...).unwrap()` (tuple). Fixed 5 call sites to
  `let (conn, _) = ...` / `let (mut conn, _) = ...` (lines 688, 710, 760, 786, 808). Production pattern: `let (conn, _report) = ...`.

### Pre-existing test bugs fixed (blocked cargo test green)
- `attachments.rs` `import_creates_file_and_rows_with_seq`: queried `original_name` from `todo_attachments`
  (column lives in `attachments`). Fixed to JOIN:
  `SELECT a.original_name, ta.seq FROM attachments a JOIN todo_attachments ta ON ta.attachment_id = a.id WHERE ta.attachment_id = ?1`.
- `attachments.rs` `gc_orphans_removes_stale_relations` phase 2: asserted `removed_relations, 0` but deleting
  t1 via raw SQL leaves a stale `todo_attachments` row → gc correctly removes it (1). Fixed assertion to 1.
- `attachments.rs:280`: `let mut file` → `let file` (unused_mut, clippy gate).
- `git_cmds.rs` `detect_cherry_picks` trailer parse: git `cherry-pick -x` writes `(cherry picked from commit <sha>)`
  WITH parens; code did `strip_prefix("cherry picked from commit ")` → always failed → `source` stayed empty.
  Fixed to strip optional parens first.

### Flaky git test root cause (important!)
`annotate_origins_cherry_by_patch_equivalence` was flaky ~40%. Root cause: `git checkout main` + immediate
`git cherry-pick B` where B and cp have IDENTICAL parent (init), tree, message, author/committer, and
**same-second commit timestamp** → byte-identical commit → SAME HASH (cp == B). Test's commits vec then
had duplicate hash → classification ambiguity (cp classified "native" not "cherry").
Fix: `std::thread::sleep(1s)` between checkout and cherry-pick so committer timestamps differ → distinct hashes.
(Not a Windows git checkout race as initially suspected; `-x` test unaffected because trailer changes the message.)

### Verification
- `cargo test -p todo-kanban-core`: 52/52 pass (5 consecutive green runs).
- `cargo clippy -p todo-kanban-core -- -D warnings`: 0 warnings.
- `cargo clippy` (workspace): 0 warnings.
- `cargo test -p mcp-server`: 10/10 pass.
- upgrade.rs test fix (2026-09-09): `ensure_too_new_rejected` hardcoded `PRAGMA user_version = 9`; after CURRENT_DATA_VERSION bumped 8→9 (v9 resources table), a v9 DB is current, not TooNew → test failed. Fixed to `CURRENT_VERSION + 1` (both PRAGMA and assert_eq). Lesson: version-constant-sensitive tests must derive from `CURRENT_VERSION`, never hardcode; always `cargo clean -p todo-kanban-config -p todo-kanban-upgrade -p todo-kanban-core` after version bumps before trusting test results.
