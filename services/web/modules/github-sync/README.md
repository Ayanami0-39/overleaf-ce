# github-sync

Mirror **all projects of one Overleaf user** into **one GitHub repository**, on
demand (there is no background worker and no real-time tracking: the user
presses “Sync now”).

## What a sync does

1. Resolves every project owned by the user (not trashed, not deleted).
2. Asks `history-v1` for the current zip of each project.
3. Writes it into the mirror working tree as `projects/<projectId>-<slug>/`,
   dropping build artefacts (`output.pdf`, `*.aux`, … — configurable).
4. Commits **at most once** (only when the tree actually changed) and pushes to
   the bound GitHub branch.

The mirror lives on the server at
`${GITHUB_SYNC_ROOT_DIRECTORY}/<userId>/repo`, so every sync is incremental: only
the diff goes over the wire.

## Conflict and idempotency rules

- `last_pushed_sha` records the commit *we* produced.
- Before pushing, the remote branch head is compared with `last_pushed_sha`.
  If somebody else moved the branch, the sync aborts with **409** instead of
  overwriting their work.
- A first sync against a non-empty repository adopts the remote head and
  fast-forwards from it.
- A sync with no changes creates no commit and pushes nothing.
- A failed push resets the mirror back to the pre-sync commit, so the next
  attempt starts clean.

## GitHub App setup

1. Create a GitHub App (Settings → Developer settings → GitHub Apps).
   - Permissions: **Repository → Contents: Read and write**, Metadata: Read.
   - No webhook needed; no callback URL needed.
2. Generate a private key and download the `.pem`.
3. Install the App on your account and pick the target repository.
4. Note the numeric **installation id** (visible in the installation URL:
   `https://github.com/settings/installations/<installation_id>`).
5. Configure the instance (`config/variables.env` in the toolkit):

```env
GITHUB_SYNC_ENABLED=true
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
GITHUB_SYNC_ROOT_DIRECTORY=/var/lib/overleaf/github-sync
```

`GITHUB_APP_PRIVATE_KEY` accepts `\n` escapes, which keeps it on one line in
`variables.env`. PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub hands out) and
PKCS#8 are both accepted — the key is converted at load time. Restart the
container afterwards.

> The App private key stays on the server. Per-request installation tokens are
> minted with `jose`, expire after one hour and are never stored. Nothing is
> written to disk except the mirror and the binding row in Mongo.

## Usage

Sign in and open `/user/github-sync`:

- **Bind repository** — installation id, `owner`, `repo`. The App installation
  must be granted access to that repository; visibility is verified before the
  binding is stored. Write access is proven by the first real push (`git push`
  succeeds with installation tokens even though the REST `permissions.push`
  flag reports `false`).
- **Sync now** — runs one sync synchronously (up to 10 minutes).
- **Unbind** — removes the binding; the mirror directory is left in place.

JSON is available for scripting with `Accept: application/json`:

| Route | Method | Purpose |
|---|---|---|
| `/user/github-sync/status` | GET | binding + project count |
| `/user/github-sync/bind` | POST | `installation_id`, `repo_owner`, `repo_name` |
| `/user/github-sync/sync` | POST | run one sync |
| `/user/github-sync/unbind` | POST | remove the binding |

## Data model

`githubSyncBindings` (one document per user):

```
user_id, installation_id, repo_owner, repo_name, branch,
last_pushed_sha, last_synced_at,
projects: [{ project_id, content_hash, synced_at }]
```

`content_hash` is a digest of the exported tree; it makes “did this project
change?” a cheap question and keeps commit messages honest.

## Limitations (by design, first iteration)

- One-way: Overleaf → GitHub. Nothing is read back from the repository.
- Current files only. The per-version Overleaf history is *not* replayed into
  git commits yet (that is a follow-up: one commit per `history-v1` version).
- Sync is a synchronous request. Large accounts may hit the 10-minute cap; move
  it to a job queue when that becomes real.
- No GitHub webhooks, no per-project opt-out, no rename detection beyond the
  `projects/<id>-<slug>` directory name.

## Tests

- `test/manual/git-mirror-smoke.mjs` — dependency-free end-to-end check of the
  git layer against a local bare repository (run with `node`, no npm install).
- `test/unit/ProjectExportUtils.test.mjs` — unit tests for path sanitising,
  artifact filtering and hashing (mocha/chai, matches the web test setup).
