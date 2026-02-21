# openclaw-backup

Backup and restore plugin for [OpenClaw](https://github.com/openclaw/openclaw) — multi-provider snapshots with age encryption.

> ⚠️ **Under active development.** Not yet ready for production use.

## Features

- **Full timestamped backups** of OpenClaw config, workspace, credentials, and cron
- **Multi-provider storage** — local filesystem + any rclone remote (S3, Google Drive, etc.)
- **age encryption** — backups encrypted at rest with automatic key management
- **Manifest integrity** — SHA-256 checksums on every file, verified on restore
- **Retention policies** — automatic pruning of old backups
- **Standalone restore** — works even when OpenClaw gateway is broken
- **Key rotation** — rotate encryption keys without re-encrypting old backups

## Quick Start

```bash
# Install as OpenClaw plugin
npm install -g openclaw-backup

# Create your first backup (auto-generates encryption key)
openclaw backup

# List backups
openclaw backup list

# Restore from latest backup
openclaw restore --confirm
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "backup": {
    "schedule": "0 * * * *",
    "encrypt": true,
    "destinations": {
      "local": {
        "path": "/mnt/backup/openclaw"
      },
      "gdrive": {
        "remote": "gdrive:openclaw-backups/"
      }
    },
    "retention": {
      "count": 168
    }
  }
}
```

## License

[Apache 2.0](LICENSE)
