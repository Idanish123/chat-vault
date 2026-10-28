# Changelog

## 2.0.0 — 2026-10-27

- Reject missing or corrupt required records during backup preparation.
- Authenticate all restore records before writing; clean up partial restores after a write failure.
- Restore backups with either their password or their saved recovery key and a new password.
- Distinguish attachment identities when merging overlapping exports.
- Save structured message records; retain support for opening legacy records.
- Show sample conversations before vault creation and guide library/password/recovery setup.
- Repair first-run recovery prompting and persist explicit key-save confirmation.
- Keep surrounding messages during search; make Latest clear filters and reach the actual ending.
- Repair corrupted UI strings; improve type sizes, focus, right-to-left content, and Unicode highlighting.
- Run hashing, parsing and archive processing in a cancellable background worker, including offline builds.
- Add visible recovery/backup/log status, control-level diagnostics, private log exports and idle locking.
- Bound preview memory with eviction rather than requiring a vault lock to release every cached preview.
- Supply a native Windows launcher and optional per-user installation with Start-menu shortcut.
- Verify launcher version and source root; require authenticated local shutdown and validate Host/Origin.
- Add data-integrity, archive, browser and Windows launcher tests, screenshots, CI configuration and ZIP checksums.

Newly written structured conversation records require version 2.0 or later. Back up an older library before upgrading. Cryptographic vault version 1 remains supported.
