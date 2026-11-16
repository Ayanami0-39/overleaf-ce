// @ts-check

// Single place that touches Overleaf's (non-public) project APIs.
//
// Everything the github-sync module needs from the host application goes
// through this file, so an Overleaf upgrade only requires adapting these few
// functions instead of hunting through the module.

import * as ProjectModule from '../../../../app/src/models/Project.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'

import { normalizeEntities } from './overleaf-entities.mjs'

const Project = ProjectModule.default ?? ProjectModule.Project

export const SOURCE = 'github-sync'

export { normalizeEntities }

/**
 * @param {string} projectId
 * @returns {Promise<{ docs: Map<string, any>, files: Map<string, any> }>}
 */
export async function getEntities(projectId) {
  const raw = await ProjectEntityHandler.promises.getAllEntities(projectId)
  return normalizeEntities(raw)
}

/**
 * @param {string} projectId
 * @param {string} entityPath
 * @param {string[]} lines
 * @param {string} userId
 */
export async function upsertDoc(projectId, entityPath, lines, userId) {
  return ProjectEntityUpdateHandler.promises.upsertDocWithPath(
    projectId,
    entityPath,
    lines,
    SOURCE,
    userId
  )
}

/**
 * @param {string} projectId
 * @param {string} entityPath
 * @param {string} fsPath
 * @param {string} userId
 */
export async function upsertFile(projectId, entityPath, fsPath, userId) {
  return ProjectEntityUpdateHandler.promises.upsertFileWithPath(
    projectId,
    entityPath,
    fsPath,
    null,
    userId,
    SOURCE
  )
}

/**
 * @param {string} userId
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function createBlankProject(userId, name) {
  const created = await ProjectCreationHandler.promises.createBlankProject(
    userId,
    name
  )
  const id = created?._id ?? created?.project?._id
  if (!id) {
    throw new Error('createBlankProject did not return a project id')
  }
  return String(id)
}

/**
 * @param {{ id?: string, name?: string, userId: string }} options
 * @returns {Promise<{ projectId: string, name: string } | null>}
 */
export async function findProject({ id, name, userId }) {
  if (id) {
    const byId = await Project.findOne(
      { _id: id, owner_ref: userId },
      { _id: 1, name: 1 }
    )
      .lean()
      .exec()
    if (byId) return { projectId: String(byId._id), name: byId.name }
  }
  if (name) {
    const byName = await Project.findOne(
      {
        name,
        owner_ref: userId,
        trashed: { $ne: userId },
        deletedAt: null,
      },
      { _id: 1, name: 1 }
    )
      .lean()
      .exec()
    if (byName) return { projectId: String(byName._id), name: byName.name }
  }
  return null
}

export default {
  SOURCE,
  normalizeEntities,
  getEntities,
  upsertDoc,
  upsertFile,
  createBlankProject,
  findProject,
}
