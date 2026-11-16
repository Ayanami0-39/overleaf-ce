// @ts-check

import crypto from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

import ProjectZipStreamManager from '../../../../app/src/Features/Downloads/ProjectZipStreamManager.mjs'

import {
  contentHash,
  isExcluded,
  safeRelativePath,
} from './ProjectExportUtils.mjs'

export class ZipFetchError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'ZipFetchError'
    this.status = details.status ?? null
  }
}

/**
 * @param {string} user
 * @param {string} pass
 */
function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/**
 * Ask history-v1 for the current project as a zip.
 *
 * history-v1 answers either with the zip itself (Community Edition) or with a
 * JSON body pointing at a signed download URL (SaaS); both shapes are handled.
 *
 * @param {{
 *   historyId: string,
 *   v1HistoryUrl: string,
 *   v1HistoryUser: string,
 *   v1HistoryPass: string,
 * }} options
 * @returns {Promise<{ zipPath: string, cleanup: () => Promise<void> }>}
 */
export async function fetchLatestProjectZip({
  historyId,
  v1HistoryUrl,
  v1HistoryUser,
  v1HistoryPass,
}) {
  const url = `${v1HistoryUrl}/projects/${encodeURIComponent(historyId)}/latest/zip`
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuth(v1HistoryUser, v1HistoryPass),
    },
  })
  if (!res.ok) {
    throw new ZipFetchError(`history-v1 zip request failed (${res.status})`, {
      status: res.status,
    })
  }

  const contentType = res.headers.get('content-type') || ''
  let buffer
  if (contentType.includes('zip')) {
    buffer = Buffer.from(await res.arrayBuffer())
  } else {
    const body = await res.json()
    if (!body?.zipUrl) {
      throw new ZipFetchError('history-v1 did not return a zip or a zipUrl')
    }
    const download = await fetch(body.zipUrl)
    if (!download.ok) {
      throw new ZipFetchError(`zip download failed (${download.status})`, {
        status: download.status,
      })
    }
    buffer = Buffer.from(await download.arrayBuffer())
  }

  const zipPath = Path.join(
    os.tmpdir(),
    `overleaf-github-sync-${crypto.randomUUID()}.zip`
  )
  await fs.writeFile(zipPath, buffer)
  return {
    zipPath,
    cleanup: async () => {
      await fs.rm(zipPath, { force: true })
    },
  }
}

/**
 * @param {string} zipPath
 * @returns {Promise<yauzl.ZipFile>}
 */
function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('could not open zip'))
      resolve(zipfile)
    })
  })
}

/**
 * @param {yauzl.ZipFile} zipfile
 * @param {yauzl.Entry} entry
 * @returns {Promise<Buffer>}
 */
function readEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('no stream'))
      const chunks = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

/**
 * Extract a project zip into `destination`, skipping build artifacts.
 *
 * The destination is expected to be empty; the caller owns wiping it, so a
 * project deleted in Overleaf disappears from the mirror instead of lingering.
 *
 * @param {{
 *   zipPath: string,
 *   destination: string,
 *   excludedPatterns: string[],
 * }} options
 * @returns {Promise<{ files: Array<{ path: string, size: number, sha256: string }> }>}
 */
export async function extractProjectZip({
  zipPath,
  destination,
  excludedPatterns,
}) {
  const zipfile = await openZip(zipPath)
  /** @type {Array<{ path: string, size: number, sha256: string }>} */
  const files = []

  await new Promise((resolve, reject) => {
    zipfile.on('error', reject)
    zipfile.on('end', resolve)
    zipfile.on('entry', async entry => {
      try {
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry()
          return
        }
        const relativePath = safeRelativePath(entry.fileName)
        if (
          relativePath === null ||
          isExcluded(relativePath, excludedPatterns)
        ) {
          zipfile.readEntry()
          return
        }
        const content = await readEntry(zipfile, entry)
        const target = Path.join(destination, relativePath)
        if (!Path.resolve(target).startsWith(Path.resolve(destination))) {
          zipfile.readEntry()
          return
        }
        await fs.mkdir(Path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
        files.push({
          path: relativePath,
          size: content.length,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        })
        zipfile.readEntry()
      } catch (err) {
        reject(err)
      }
    })
    zipfile.readEntry()
  })

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files }
}

/**
 * Build a zip of the project's *current* files using the web service's own
 * exporter, the same code path as "Download as zip".
 *
 * This avoids the history-v1 HTTP API entirely: it needs no JWT and no
 * service-to-service credentials, and it is identical in Community Edition and
 * SaaS deployments.
 *
 * @param {{ projectId: string }} options
 * @returns {Promise<{ zipPath: string, cleanup: () => Promise<void> }>}
 */
export async function fetchProjectZip({ projectId }) {
  const stream = await new Promise((resolve, reject) => {
    ProjectZipStreamManager.createZipStreamForProject(
      projectId,
      false,
      null,
      (err, projectStream) => {
        if (err) reject(err)
        else resolve(projectStream)
      }
    )
  })

  const zipPath = Path.join(
    os.tmpdir(),
    `overleaf-github-sync-${crypto.randomUUID()}.zip`
  )
  await pipeline(stream, createWriteStream(zipPath))
  return {
    zipPath,
    cleanup: async () => {
      await fs.rm(zipPath, { force: true })
    },
  }
}

export { contentHash, isExcluded, safeRelativePath }

export default {
  fetchLatestProjectZip,
  fetchProjectZip,
  extractProjectZip,
  contentHash,
  isExcluded,
  safeRelativePath,
}

