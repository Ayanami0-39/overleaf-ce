// @ts-check

import fs from 'node:fs/promises'
import Path from 'node:path'

import * as ProjectModule from '../../../../app/src/models/Project.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'

import GitMirror from './GitMirror.mjs'

const Project = ProjectModule.default ?? ProjectModule.Project

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

const SOURCE = 'github-sync'

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
 * `getAllEntities` returns arrays of `{ path, doc }` / `{ path, file }` on 6.x;
 * index them by path (with a leading slash) for lookup.
 *
 * @param {any} entities
 */
function indexEntities(entities) {
  /** @type {Map<string, any>} */
  const docs = new Map()
  for (const entry of entities.docs || []) {
    if (entry && entry.path) docs.set(entry.path, entry.doc)
  }
  /** @type {Map<string, any>} */
  const files = new Map()
  for (const entry of entities.files || []) {
    if (entry && entry.path) files.set(entry.path, entry.file)
  }
  return { docs, files }
}

/**
 * @param {{ dirName: string, userId: string }} options
 */
async function resolveProject({ dirName, userId }) {
  const match = /^([0-9a-f]{24})-(.+)$/.exec(dirName)
  const projectIdFromName = match ? match[1] : null
  const slug = match ? match[2] : dirName

  if (projectIdFromName) {
    const byId = await Project.findOne(
      { _id: projectIdFromName, owner_ref: userId },
      { _id: 1 }
    )
      .lean()
      .exec()
    if (byId) return { projectId: String(byId._id), created: false }
  }

  const byName = await Project.findOne(
    { name: slug, owner_ref: userId, trashed: { $ne: userId }, deletedAt: null },
    { _id: 1 }
  )
    .lean()
    .exec()
  if (byName) return { projectId: String(byName._id), created: false }

  const project = await ProjectCreationHandler.promises.createBlankProject(
    userId,
    slug
  )
  const projectId = String(project._id ?? project.project?._id)
  return { projectId, created: true }
}

/**
 * Copy the repository's project directories back into Overleaf.
 *
 * Missing projects are created; existing ones are updated. Files that only
 * exist in Overleaf are kept.
 *
 * @param {{
 *   userId: string,
 *   binding: { repo_owner: string, repo_name: string, branch?: string },
 *   token: string,
 *   rootDirectory: string,
 * }} options
 */
export async function pullUser({ userId, binding, token, rootDirectory }) {
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

    let resolved
    try {
      resolved = await resolveProject({ dirName: dir.name, userId })
    } catch (err) {
      skipped++
      continue
    }
    if (resolved.created) projectsCreated++
    const { projectId } = resolved

    const { docs, files } = indexEntities(
      await ProjectEntityHandler.promises.getAllEntities(projectId)
    )

    const projectDir = Path.join(projectsRoot, dir.name)
    const entries = await walk(projectDir)
    let touched = false

    for (const entry of entries) {
      const entityPath = `/${entry.rel}`
      const ext = Path.extname(entry.rel).toLowerCase()

      if (TEXT_EXTENSIONS.has(ext)) {
        const content = await fs.readFile(entry.abs, 'utf8')
        const lines = content.split('\n')
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

        const existing = docs.get(entityPath)
        const existingLines = existing && Array.isArray(existing.lines)
          ? existing.lines
          : null
        if (existingLines) {
          const same =
            existingLines.length === lines.length &&
            existingLines.every((line, i) => line === lines[i])
          if (same) continue
        }
        await ProjectEntityUpdateHandler.promises.upsertDocWithPath(
          projectId,
          entityPath,
          lines,
          SOURCE,
          userId
        )
        if (existingLines) updated++
        else created++
        touched = true
      } else {
        const existing = files.get(entityPath)
        await ProjectEntityUpdateHandler.promises.upsertFileWithPath(
          projectId,
          entityPath,
          entry.abs,
          null,
          userId,
          SOURCE
        )
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

export default { pullUser }
