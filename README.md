# openclaw-backup

Backup and restore plugin for [OpenClaw](https://github.com/openclaw/openclaw). Creates timestamped,
compressed snapshots of your OpenClaw data and pushes them to one or more storage destinations with
optional age encryption.

> **Under active development.** Not yet ready for production use.

## Features

- **Timestamped snapshots** — full backup of config, workspace, credentials, and cron
- **Multi-provider storage** — local filesystem and any rclone remote (S3, GCS, Google Drive, B2, …)
- **age encryption** — archives encrypted at rest; key auto-generated on first backup
- **Manifest integrity** — SHA-256 checksum on every file, verified before restore
- **Retention policies** — automatic pruning keeps storage bounded
- **Standalone restore** — disaster-recovery tool works even when OpenClaw is broken
- **Key rotation** — retire old keys and optionally re-encrypt existing archives

## Installation

**As an OpenClaw plugin (recommended):**

```bash
npm install -g openclaw-backup
# OpenClaw loads it automatically via openclaw.plugin.json
```

**From source:**

```bash
git clone https://github.com/briancolinger/openclaw-backup-plugin.git
cd openclaw-backup-plugin
npm install && npm run build
```

## Quick Start

Add a minimal config block to `~/.openclaw/openclaw.json`:

```json
{
  "backup": {
    "encrypt": true,
    "destinations": {
      "local": { "path": "/Volumes/Backup/openclaw" }
    }
  }
}
```

Run your first backup:

```bash
openclaw backup
# → generates ~/.openclaw/.secrets/backup.age on first run
# → prints the public key — store it somewhere safe!
```

List and verify:

```bash
openclaw backup list
openclaw backup status
```

Restore latest:

```bash
openclaw restore --source local --confirm
```

## Configuration Reference

All fields live under the `"backup"` key in `openclaw.json`.

| Field                | Type     | Default                           | Description                                      |
| -------------------- | -------- | --------------------------------- | ------------------------------------------------ |
| `schedule`           | string   | —                                 | Cron expression for automatic backups (5 fields) |
| `encrypt`            | boolean  | `true`                            | Encrypt archives with age                        |
| `encryptKeyPath`     | string   | `~/.openclaw/.secrets/backup.age` | Path to age key file                             |
| `include`            | string[] | `["~/.openclaw"]`                 | Directories to back up                           |
| `exclude`            | string[] | logs, media, cache dirs           | Paths/globs to skip                              |
| `extraPaths`         | string[] | `[]`                              | Additional paths beyond the defaults             |
| `includeTranscripts` | boolean  | `false`                           | Include `.jsonl` session transcripts             |
| `includePersistor`   | boolean  | `false`                           | Include Persistor knowledge-graph export         |
| `retention.count`    | number   | `168`                             | Maximum backups to keep (oldest pruned first)    |
| `destinations`       | object   | `{}`                              | Named storage destinations (see below)           |

**Full example:**

```json
{
  "backup": {
    "schedule": "0 * * * *",
    "encrypt": true,
    "encryptKeyPath": "~/.openclaw/.secrets/backup.age",
    "include": ["~/.openclaw"],
    "exclude": ["~/.openclaw/logs", "~/.openclaw/media", "*.jsonl"],
    "extraPaths": ["~/my-project/.env"],
    "includeTranscripts": false,
    "includePersistor": true,
    "retention": { "count": 168 },
    "destinations": {
      "local": { "path": "/Volumes/Backup/openclaw" },
      "s3": { "remote": "s3:my-bucket/openclaw/" },
      "gdrive": { "remote": "gdrive:openclaw-backups/" }
    }
  }
}
```

## CLI Reference

### `openclaw backup`

Create a new backup.

```
Options:
  --dest <name>           Target a specific destination (default: all)
  --include-transcripts   Include .jsonl session transcript files
  --include-persistor     Include Persistor KG export
  --dry-run               Preview files without creating an archive
```

### `openclaw backup list`

List available backups from the index.

```
Options:
  --source <name>   Filter by storage provider name
  --refresh         Force re-fetch manifests from remote providers
```

### `openclaw backup prune`

Delete old backups according to retention policy.

```
Options:
  --source <name>   Limit pruning to a specific provider
  --keep <count>    Override configured retention count
```

### `openclaw backup status`

Show last backup time, destination health, and prerequisite status (age, rclone).

### `openclaw backup rotate-key`

Retire the current age key and generate a new one. The old key is archived to
`~/.openclaw/.secrets/backup-keys/` so existing encrypted backups remain restorable.

```
Options:
  --reencrypt         Re-encrypt all existing backups with the new key
  --source <name>     Limit re-encryption to a specific provider
```

### `openclaw restore`

Restore files from a backup. **Overwrites your current files.**

```
Options:
  --source <name>       Required: storage provider to restore from
  --timestamp <ts>      Specific backup to restore (default: latest)
  --dry-run             Preview files that would be restored
  --skip-pre-backup     Skip the safety backup created before restoring
  --confirm             Required: acknowledge overwrite
```

## Storage Providers

### Local filesystem

```json
"destinations": {
  "local": { "path": "/path/to/backup/dir" }
}
```

No external tools required. Works with any mounted path: external drive, NAS, tmpfs.

### rclone remotes

Requires [rclone](https://rclone.org) installed and configured (`rclone config`).

```json
"destinations": {
  "s3":    { "remote": "s3:my-bucket/openclaw-backups/" },
  "gdrive": { "remote": "gdrive:openclaw/" },
  "b2":    { "remote": "backblaze:my-bucket/openclaw/" }
}
```

Any rclone backend works. Run `openclaw backup status` to verify connectivity.

## Encryption

Backups are encrypted with [age](https://github.com/FiloSottile/age) when `"encrypt": true`.

**First backup:** a key pair is auto-generated at `encryptKeyPath`. The public key is
printed to stdout — **back up this key file immediately**. Without it, encrypted archives
cannot be restored.

**Key rotation:**

```bash
openclaw backup rotate-key             # rotate; keep old backups as-is
openclaw backup rotate-key --reencrypt # rotate and re-encrypt all archives
```

Old keys are archived in `~/.openclaw/.secrets/backup-keys/`. Any backup is restorable
as long as the matching key is present in that directory.

## Standalone Restore

If your OpenClaw installation is broken, use the standalone restore binary directly:

```bash
# Shipped with the package as `openclaw-backup`
openclaw-backup restore \
  --source local \
  --path /Volumes/Backup/openclaw \
  --key ~/.openclaw/.secrets/backup.age \
  --confirm
```

Requires only Node.js 22+ — no OpenClaw gateway, no plugin system.

## Architecture

```
src/
  index.ts              Plugin entry — registers CLI with OpenClaw
  types.ts              All interfaces and shared constants
  config.ts             Config parsing and validation
  cli.ts                Commander command handlers
  index-manager.ts      Backup index: remote-first, local cache
  prerequisites.ts      Dependency detection (age, rclone)
  backup/
    collector.ts        File walking with include/exclude rules
    manifest.ts         SHA-256 manifest generation and validation
    archive.ts          tar.gz create/extract
    encrypt.ts          age encryption/decryption and key management
    backup.ts           Backup orchestration
    rotate.ts           Key rotation
  storage/
    local.ts            Local filesystem provider
    rclone.ts           rclone provider (S3, gdrive, etc.)
  restore/
    restore.ts          Restore orchestration
    standalone.ts       Standalone restore binary
```

Every module has a `.test.ts` counterpart. `tests/integration.test.ts` exercises
the full backup → list → restore → prune cycle against real local storage without
any external dependencies.

## Contributing

See [CLAUDE.md](CLAUDE.md) for the full engineering standards: type safety rules,
file size limits, testing requirements, commit format, and architecture conventions.

```bash
# Build gate — must pass before every commit
npm run build && npm run lint && npm run format:check && npm run test
```

Bug reports and pull requests:
[github.com/briancolinger/openclaw-backup-plugin/issues](https://github.com/briancolinger/openclaw-backup-plugin/issues)

## License

[Apache 2.0](LICENSE) — © Brian Colinger
