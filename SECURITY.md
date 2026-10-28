# Security model

Chat Vault stores encrypted WhatsApp export archives on a device controlled by its user. It protects stored records against access without a password or previously configured recovery key, and detects authenticated-record modification. It does not protect an unlocked library from a compromised OS, browser or extension.

## Properties

- AES-256-GCM records use random IVs and authenticated data scoped to the vault and record name.
- PBKDF2-SHA-256 protects a separate data-key envelope; recovery uses an independent random 256-bit key.
- Password and recovery changes preserve the data key. Old backups and copied older headers retain their original access methods. Credential changes cannot revoke data already copied or decrypted by another party.
- A failed password/header write must preserve earlier access. A stale window must refuse index updates, backups and cleanup against a changed revision.
- Backups must reject missing or unauthentic required records. Restore must validate the entire archive before committing the destination header.
- Imports are treated as untrusted. Enforce archive size/path/count/ratio limits and integrity checks; render imported text as text; never execute imported documents.
- The local desktop server serves allowlisted application assets, never the vault folder. Authenticated window-lifetime and shutdown controls carry no chat content. Host and Origin checks restrict unrelated requests.
- Logs must omit credentials, chat text, query text and participant names. Log failures are visible; diagnostics are not a tamper-proof audit service.

## Development checks

Run `node tests/run.js`, `node tests/browser.js`, and `node tests/launcher.js` on Windows after building. The browser tests use synthetic data and a disposable profile. Never test against a user's personal vault without their explicit direction.

The native executable is unsigned. No independent penetration test, screen-reader certification, publisher-signing review or real-user usability certification is claimed by the included test suite.

Report reproducible security issues to the project maintainer through their established private contact. A dedicated public security-reporting channel has not been configured in this source package. Do not attach real chat archives, passwords, recovery keys or personal vault records to public reports.
