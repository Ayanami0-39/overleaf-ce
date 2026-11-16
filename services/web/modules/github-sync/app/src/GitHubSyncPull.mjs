// @ts-check

import fs from 'node:fs/promises'
import Path from 'node:path'

import GitMirror from './GitMirror.mjs'
import {
  createBlankProject,
  findProject,
  getEntities,
  upsertDoc,
  upsertFile,
} from './overleaf-adapter.mjs'

const TEXT_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.bst',
  '.cls',
  '.sty',
  '.cfg',
  '.def',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tikz',
  '.pgf',
  '.html',
  '.css',
  '.js',
])

/**
 * @param {string} dir
 * @param {string} [prefix]
 */
async function walk(dir, prefix = '') {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const abs = Path.join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(abs, rel)))
    else out.push({ abs, rel })
  }
  return out
}

/**
 * @param {string} dirName
 */
function parseDirName(dirName) {
  const match = /^([0-9a-f]{24})-(.+)$/.exec(dirName)
  return match
    ? { projectId: match[1], slug: match[2] }
    : { projectId: null, slug: dirName }
}

/**
 * @param {{ dirName: string, userId: string }} options
 */
async function resolve({ dirName, userId }) {
  const { projectId, slug } = parseDirName(dirName)
  const found = await findProject({ id: projectId ?? undefined, name: slug, userId })
  if (found) return { ...found, created: false }
  const createdId = await createBlankProject(userId, slug)
  return { projectId: createdId, name: slug, created: true }
}

/**
 * Describe what a pull would do, without writing anything.
 *
 * @param {{
 *   userId: string,
 *   binding: { repo_owner: string, repo_name: string, branch?: string },
 *   token: string,
 *   rootDirectory: string,
 * }} options
 */
export async function previewUser({ userId, binding, token, rootDirectory }) {
  const branch = binding.branch || 'main'
  const mirrorDirectory = Path.join(rootDirectory, String(userId), 'repo')
  const projectsRoot = Path.join(mirrorDirectory, 'projects')

  const mirror = new GitMirror({ directory: mirrorDirectory, branch })
  await mirror.ensureRepo({
    remoteUrl: `https://github.com/${binding.repo_owner}/${binding.repo_name}.git`,
  })
  await mirror.fetch({ token })
  await mirror.resetHard(`origin/${branch}`)

  let dirs = []
  try {
    dirs = await fs.readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const { projectId, slug } = parseDirName(dir.name)
    const found = await findProject({ id: projectId ?? undefined, name: slug, userId })
    const { docs, files } = found
      ? await getEntities(found.projectId)
      : { docs: new Map(), files: new Map() }

    let added = 0
    let changed = 0
    let same = 0
    for (const entry of await walk(Path.join(projectsRoot, dir.name))) {
      const entityPath = `/${entry.rel}`
      const ext = Path.extname(entry.rel).toLowerCase()
      if (TEXT_EXTENSIONS.has(ext)) {
        const content = await fs.readFile(entry.abs, 'utf8')
        const lines = content.split('\n')
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
        const existing = docs.get(entityPath)
        const existingLines =
          existing && Array.isArray(existing.lines) ? existing.lines : null
        if (!existingLines) added++
        else if (
          existingLines.length === lines.length &&
          existingLines.every((line, i) => line === lines[i])
        )
          same++
        else changed++
      } else if (files.has(entityPath)) {
        same++
      } else {
        added++
      }
    }

    out.push({
      dirName: dir.name,
      name: found ? found.name : slug,
      projectId: found ? found.projectId : null,
      willCreate: !found,
      files: { added, changed, same },
    })
  }
  return out
}

/**
 * Copy the selected repository project directories back into Overleaf.
 *
 * Only directories present in `actions` with 'create' or 'update' are touched;
 * everything else is ignored. Files that only exist in Overleaf are kept.
 *
 * @param {{
 *   userId: string,
 *   binding: { repo_owner: string, repo_name: string, branch?: string },
 *   token: string,
 *   rootDirectory: string,
 *   actions?: Record<string, 'create' | 'update'>,
 * }} options
 */
export async function pullUser({
  userId,
  binding,
  token,
  rootDirectory,
  actions = {},
}) {
  const branch = binding.branch || 'main'
  const mirrorDirectory = Path.join(rootDirectory, String(userId), 'repo')
  const projectsRoot = Path.join(mirrorDirectory, 'projects')

  const mirror = new GitMirror({ directory: mirrorDirectory, branch })
  await mirror.ensureRepo({
    remoteUrl: `https://github.com/${binding.repo_owner}/${binding.repo_name}.git`,
  })
  await mirror.fetch({ token })
  await mirror.resetHard(`origin/${branch}`)

  let dirs = []
  try {
    dirs = await fs.readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return { projects: 0, updated: 0, created: 0, projectsCreated: 0, skipped: 0 }
  }

  let updated = 0
  let created = 0
  let projectsCreated = 0
  let skipped = 0
  let touchedProjects = 0

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const action = actions[dir.name]
    if (action !== 'create' && action !== 'update') continue

    let resolved
    try {
      resolved = await resolve({ dirName: dir.name, userId })
    } catch {
      skipped++
      continue
    }
    if (resolved.created) projectsCreated++
    const projectId = resolved.projectId

    const { docs, files } = await getEntities(projectId)
    const projectDir = Path.join(projectsRoot, dir.name)
    let touched = false

    for (const entry of await walk(projectDir)) {
      const entityPath = `/${entry.rel}`
      const ext = Path.extname(entry.rel).toLowerCase()

      if (TEXT_EXTENSIONS.has(ext)) {
        const content = await fs.readFile(entry.abs, 'utf8')
        const lines = content.split('\n')
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

        const existing = docs.get(entityPath)
        const existingLines =
          existing && Array.isArray(existing.lines) ? existing.lines : null
        if (existingLines) {
          const same =
            existingLines.length === lines.length &&
            existingLines.every((line, i) => line === lines[i])
          if (same) continue
        }
        await upsertDoc(projectId, entityPath, lines, userId)
        if (existingLines) updated++
        else created++
        touched = true
      } else {
        const existing = files.get(entityPath)
        await upsertFile(projectId, entityPath, entry.abs, userId)
        if (existing) updated++
        else created++
        touched = true
      }
    }

    if (touched || resolved.created) touchedProjects++
  }

  return {
    projects: touchedProjects,
    updated,
    created,
    projectsCreated,
    skipped,
  }
}

export default { previewUser, pullUser }
