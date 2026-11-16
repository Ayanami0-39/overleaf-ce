// @ts-check

import fs from 'node:fs/promises'
import Path from 'node:path'

import Settings from '@overleaf/settings'

import GitMirror from './GitMirror.mjs'
import { slugify } from './ProjectExportUtils.mjs'
import {
  contentHash,
  extractProjectZip,
  fetchLatestProjectZip,
} from './ProjectZipFetcher.mjs'

export class SyncConflictError extends Error {
  /**
   * @param {string} message
   * @param {{ remoteSha?: string|null, expectedSha?: string|null }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'SyncConflictError'
    this.remoteSha = details.remoteSha ?? null
    this.expectedSha = details.expectedSha ?? null
  }
}

/** @type {Map<string, Promise<any>>} */
const locks = new Map()

/**
 * Serialize syncs for one user. A double-clicked button must not produce two
 * pushes racing for the same branch.
 *
 * @template T
 * @param {string} userId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withUserLock(userId, fn) {
  const previous = locks.get(userId) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(fn)
  locks.set(
    userId,
    current.catch(() => {})
  )
  try {
    return await current
  } finally {
    if (locks.get(userId) === current) {
      locks.delete(userId)
    }
  }
}

/**
 * List the project directories the mirror currently contains, so projects that
 * were deleted (or renamed) in Overleaf do not linger in the repository.
 *
 * @param {string} projectsRoot
 * @returns {Promise<string[]>}
 */
async function listMirroredProjects(projectsRoot) {
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(e => e.name)
  } catch (/** @type {any} */ err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * Export every project of one user into a single git repository and push it.
 *
 * The mirror keeps its own history: each sync adds at most one commit, so an
 * unchanged sync is a no-op. The remote is only updated when we can prove it is
 * still at the commit we last produced; otherwise we refuse and let a human
 * decide, which is the safe behaviour for a manual, one-direction sync.
 *
 * @param {{
 *   userId: string,
 *   binding: {
 *     installation_id: string,
 *     repo_owner: string,
 *     repo_name: string,
 *     branch?: string,
 *     last_pushed_sha?: string|null,
 *     projects?: Array<{ project_id: any, content_hash?: string|null }>,
 *   },
 *   projects: Array<{ id: string, name: string, historyId: string|null }>,
 *   token: string,
 *   authorName?: string,
 *   authorEmail?: string,
 * }} options
 */
export async function syncUser({
  userId,
  binding,
  projects,
  token,
  authorName = 'Overleaf GitHub Sync',
  authorEmail = 'overleaf-github-sync@localhost',
}) {
  const config = Settings.githubSync
  const branch = binding.branch || config.branch || 'main'
  const mirrorDirectory = Path.join(
    config.rootDirectory,
    String(userId),
    'repo'
  )
  const projectsRoot = Path.join(mirrorDirectory, 'projects')
  const excludedPatterns = config.excludedPatterns

  const mirror = new GitMirror({ directory: mirrorDirectory, branch })
  await mirror.ensureRepo({
    remoteUrl: `https://github.com/${binding.repo_owner}/${binding.repo_name}.git`,
  })

  const remoteSha = await mirror.remoteSha({ token, branch })
  if (remoteSha) {
    if (binding.last_pushed_sha && remoteSha !== binding.last_pushed_sha) {
      throw new SyncConflictError(
        'the GitHub branch moved since the last sync; refusing to overwrite it',
        { remoteSha, expectedSha: binding.last_pushed_sha }
      )
    }
    await mirror.fetch({ token })
    await mirror.resetHard(`origin/${branch}`)
  }
  const baseSha = await mirror.headSha()

  /** @type {Array<{ id: string, name: string, changed: boolean, hash: string|null, skipped: boolean }>} */
  const projectResults = []
  const seenDirectories = new Set()
  /** @type {string[]} */
  const commitLines = []

  for (const project of projects) {
    const directoryName = `${project.id}-${slugify(project.name)}`
    seenDirectories.add(directoryName)
    const destination = Path.join(projectsRoot, directoryName)

    if (!project.historyId) {
      projectResults.push({
        id: project.id,
        name: project.name,
        changed: false,
        hash: null,
        skipped: true,
      })
      continue
    }

    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(destination, { recursive: true })

    const { zipPath, cleanup } = await fetchLatestProjectZip({
      historyId: project.historyId,
      v1HistoryUrl: Settings.apis.v1_history.url,
      v1HistoryUser: Settings.apis.v1_history.user,
      v1HistoryPass: Settings.apis.v1_history.pass,
    })
    let hash
    try {
      const { files } = await extractProjectZip({
        zipPath,
        destination,
        excludedPatterns,
      })
      hash = contentHash(files)
    } finally {
      await cleanup()
    }

    const previous = (binding.projects || []).find(
      entry => String(entry.project_id) === String(project.id)
    )
    const changed = previous?.content_hash !== hash
    projectResults.push({
      id: project.id,
      name: project.name,
      changed,
      hash,
      skipped: false,
    })
    if (changed) {
      commitLines.push(`- ${project.name} (${project.id})`)
    }
  }

  // Drop directories for projects that no longer exist for this user.
  for (const existing of await listMirroredProjects(projectsRoot)) {
    if (!seenDirectories.has(existing)) {
      await fs.rm(Path.join(projectsRoot, existing), {
        recursive: true,
        force: true,
      })
    }
  }

  await mirror.stageAll()
  const hasChanges = await mirror.hasStagedChanges()

  let commitSha = baseSha
  if (hasChanges) {
    const message = [
      `Sync Overleaf projects (${new Date().toISOString()})`,
      '',
      ...commitLines,
    ].join('\n')
    commitSha = await mirror.commit({ message, authorName, authorEmail })
  }

  let pushed = false
  if (hasChanges && commitSha) {
    try {
      await mirror.push({ token, branch })
      pushed = true
    } catch (/** @type {any} */ err) {
      if (baseSha) {
        await mirror.resetHard(baseSha).catch(() => {})
      }
      throw err
    }
  }

  return {
    pushed,
    commitSha: pushed ? commitSha : null,
    projectCount: projects.length,
    changedProjects: projectResults.filter(p => p.changed).length,
    projects: projectResults,
  }
}

export default { syncUser, slugify, withUserLock, SyncConflictError }
