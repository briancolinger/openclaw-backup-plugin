# CLAUDE.md — OpenClaw Backup Plugin

## Project

OpenClaw backup/restore plugin. TypeScript, Node.js 22+, ESM.

Repo: `github.com/briancolinger/openclaw-backup-plugin`
Local: `/home/brian/code/openclaw-backup-plugin`

## Build Gate

Before committing, ALL of these must pass:

```bash
npm run build && npm run lint && npm run format:check && npm run test
```

If any fail, fix them. Do not commit broken code. Do not skip tests.

## Type Safety

- tsconfig.json has `"strict": true` — do not weaken it
- ZERO use of `any` — use `unknown` and narrow with type guards
- ZERO type assertions (`as`) — use type guards or generics
- ZERO non-null assertions (`!`) — use `?.` and `??`
- Explicit return types on ALL exported functions
- Use `type` keyword for type-only imports: `import { type Foo } from './types.js'`

## File Structure

- No file over 300 lines. If approaching 250, plan how to split.
- One concern per file. Two responsibilities = two files.
- All types/interfaces live in `types.ts` (or per-module types file)
- Implementation files import from types files, not each other's internals

## Functions

- Max 50 lines per function. Extract helpers.
- No more than 3 levels of nesting. Use early returns.
- Pure functions preferred. Side effects at boundaries only.
- No default exports. Named exports only.

## Error Handling

- Every error path handled. No empty catch blocks.
- Wrap errors: `throw new Error(\`msg: \${cause.message}\`, { cause })`
- User-facing errors: clear and actionable, not stack traces
- Child process errors: capture stderr, include in error message

## Interfaces

- Define interfaces BEFORE implementation
- `StorageProvider`, `BackupCollector`, `Archiver`, `Encryptor` — all interface-driven
- Depend on interfaces, not concrete types
- Use dependency injection (pass deps as params)

## Naming

- Interfaces: PascalCase (`StorageProvider`)
- Functions: camelCase, verb-first (`createArchive`)
- Constants: SCREAMING_SNAKE_CASE
- Files: kebab-case (`index-manager.ts`)

## Imports

- Order: `node:` builtins → external → internal → types
- Always use `.js` extension in import paths (ESM)
- No circular imports

## Child Processes (rclone, age)

- Always `execFile` (not `exec`) — no shell injection
- Always capture stdout AND stderr
- Always set a timeout
- Always check exit code AND stderr
- Pass arguments as arrays, never string interpolation

## Testing

- Every module has a `.test.ts` file
- Mock filesystem and child_process — no real I/O in unit tests
- Descriptive names: `should throw when manifest checksum does not match`
- Test edge cases: empty dirs, missing files, permission errors, corrupt archives

## Refactoring Rule

If you move, rename, or change the signature of any function:
- Update EVERY file that imports or references it
- Update EVERY test that mocks or calls it
- ALL tests must still pass after your changes
- Do NOT leave broken mocks or stale imports

## Commits

- Conventional: `feat:`, `fix:`, `test:`, `chore:`, `docs:`
- One logical change per commit
- Message explains WHY, not just WHAT

## Architecture

```
src/
  index.ts              # Plugin entry (registers CLI + hooks)
  backup/
    collector.ts        # File walking with include/exclude
    manifest.ts         # Manifest generation + checksum validation
    archive.ts          # tar.gz create/extract
    encrypt.ts          # age encryption/decryption
  storage/
    types.ts            # StorageProvider interface
    local.ts            # Local filesystem provider
    rclone.ts           # rclone provider (S3, gdrive, etc.)
  restore/
    restore.ts          # Restore orchestration
    standalone.ts       # Standalone restore (no gateway)
  index-manager.ts      # Backup index (remote-first, local cache)
  config.ts             # Config parsing + validation
  prerequisites.ts      # Dependency detection
  cli.ts                # CLI command registration
  types.ts              # Shared types/interfaces
```

## Key Interfaces (in src/types.ts)

- `StorageProvider` — push, pull, list, delete archives
- `BackupManifest` — schema_version, files with checksums, metadata
- `BackupConfig` — parsed from openclaw.json `backup` key
- `BackupEntry` — timestamp, provider, size, manifest ref
