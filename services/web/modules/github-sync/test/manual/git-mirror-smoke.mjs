// Standalone smoke test for the git layer. No npm install required:
//
//   node services/web/modules/github-sync/test/manual/git-mirror-smoke.mjs
//
// It creates a temporary bare repository as "remote", pushes to it through the
// same GitMirror used in production, and checks the conflict behaviour.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { promisify } from 'node:util'

import GitMirror from '../../app/src/GitMirror.mjs'
import {
  contentHash,
  isExcluded,
  safeRelativePath,
  slugify,
} from '../../app/src/ProjectExportUtils.mjs'

const execFileAsync = promisify(execFile)

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

async function main() {
  const root = await fs.mkdtemp(Path.join(os.tmpdir(), 'gh-sync-smoke-'))
  const remote = Path.join(root, 'remote.git')
  const mirrorDir = Path.join(root, 'mirror')
  const otherClone = Path.join(root, 'other')

  console.log('temp dir:', root)
  await git(root, ['init', '--bare', '--quiet', remote])

  // --- utils ---------------------------------------------------------------
  assert.equal(safeRelativePath('main.tex'), 'main.tex')
  assert.equal(safeRelativePath('../evil.tex'), null)
  assert.equal(safeRelativePath('/etc/passwd'), null)
  assert.equal(safeRelativePath('C:/x.tex'), null)
  assert.ok(isExcluded('output.pdf', ['^output\\.pdf$']))
  assert.ok(isExcluded('.git/config', []))
  assert.ok(!isExcluded('main.tex', ['^output\\.pdf$']))
  assert.equal(slugify('My Proposal: 2026!'), 'my-proposal-2026')
  assert.equal(
    contentHash([
      { path: 'a', sha256: 'x' },
      { path: 'b', sha256: 'y' },
    ]) === contentHash([
      { path: 'a', sha256: 'x' },
      { path: 'b', sha256: 'y' },
    ]),
    true
  )
  console.log('utils: ok')

  // --- first commit + push -------------------------------------------------
  const mirror = new GitMirror({ directory: mirrorDir, branch: 'main' })
  await mirror.ensureRepo({ remoteUrl: remote })
  await fs.mkdir(Path.join(mirrorDir, 'projects', 'p1-demo'), {
    recursive: true,
  })
  await fs.writeFile(
    Path.join(mirrorDir, 'projects', 'p1-demo', 'main.tex'),
    '\\documentclass{article}\n'
  )
  await mirror.stageAll()
  assert.equal(await mirror.hasStagedChanges(), true)
  const sha1 = await mirror.commit({
    message: 'first',
    authorName: 'smoke',
    authorEmail: 'smoke@localhost',
  })
  await mirror.push({ token: '' }) // local path remote: no auth needed
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), sha1)
  console.log('first push: ok', sha1.slice(0, 8))

  // --- no-op sync ----------------------------------------------------------
  await mirror.stageAll()
  assert.equal(await mirror.hasStagedChanges(), false)
  console.log('idempotent stage: ok')

  // --- second commit -------------------------------------------------------
  await fs.writeFile(
    Path.join(mirrorDir, 'projects', 'p1-demo', 'main.tex'),
    '\\documentclass{article}\n% changed\n'
  )
  await mirror.stageAll()
  const sha2 = await mirror.commit({
    message: 'second',
    authorName: 'smoke',
    authorEmail: 'smoke@localhost',
  })
  await mirror.push({ token: '' })
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), sha2)
  assert.equal(await mirror.remoteSha({ token: '' }), sha2)
  console.log('second push: ok', sha2.slice(0, 8))

  // --- remote moved underneath us: push must fail --------------------------
  await git(root, ['clone', '--quiet', '--branch', 'main', remote, otherClone])
  await git(otherClone, ['-c', 'user.name=other', '-c', 'user.email=o@x', 'commit', '--allow-empty', '-m', 'other'])
  await git(otherClone, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  console.log('other clone pushed:', await git(remote, ['rev-parse', 'refs/heads/main']))

  await fs.writeFile(
    Path.join(mirrorDir, 'projects', 'p1-demo', 'main.tex'),
    '\\documentclass{article}\n% local\n'
  )
  await mirror.stageAll()
  await mirror.commit({
    message: 'third',
    authorName: 'smoke',
    authorEmail: 'smoke@localhost',
  })
  let rejected = false
  try {
    await mirror.push({ token: '' })
  } catch (/** @type {any} */ err) {
    rejected = true
    console.log('push rejected as expected:', String(err.message).slice(0, 60))
  }
  assert.equal(rejected, true, 'push should have been rejected')
  console.log('non-fast-forward rejection: ok')

  await fs.rm(root, { recursive: true, force: true })
  console.log('\nALL GOOD')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
