// @ts-check

import Path from 'node:path'

import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

import * as ProjectModule from '../../../../app/src/models/Project.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import GitHubSyncBinding from './GitHubSyncBinding.mjs'
import {
  assertRepositoryAccess,
  createInstallationToken,
  GitHubApiError,
} from './GitHubAppAuth.mjs'
import { SyncConflictError, syncUser, withUserLock } from './GitHubSyncService.mjs'
import { pullUser } from './GitHubSyncPull.mjs'

// `Project` is a default export on newer Overleaf releases and a named export
// on 6.x, so go through the module namespace and pick whichever exists.
const Project = ProjectModule.default ?? ProjectModule.Project

const INSTALLATION_ID_PATTERN = /^\d+$/
const REPO_PART_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * @param {any} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {import('express').Request} req
 */
function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json')
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} status
 * @param {any} payload
 */
function respond(req, res, status, payload) {
  if (wantsJson(req)) {
    return res.status(status).json(payload)
  }
  const text =
    typeof payload === 'string'
      ? payload
      : payload?.message ?? JSON.stringify(payload)
  const ok = status < 400
  res
    .status(ok ? 200 : status)
    .type('text/html')
    .send(`<!doctype html><meta charset="utf-8"><title>GitHub Sync</title>
<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto;line-height:1.6">
<h1>${ok ? 'Done' : 'Failed'}</h1>
<pre style="white-space:pre-wrap;background:#f7f7f7;padding:1rem">${escapeHtml(text)}</pre>
<p><a href="/user/github-sync">Back to /user/github-sync</a></p></body>`)
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function ensureEnabled(req, res, next) {
  if (!Settings.githubSync?.enabled) {
    return res.status(404).type('text/plain').send('Not found')
  }
  next()
}

/**
 * @param {string} userId
 */
async function loadBinding(userId) {
  return GitHubSyncBinding.findOne({ user_id: userId }).lean().exec()
}

/**
 * @param {string} userId
 */
async function loadProjects(userId) {
  const projects = await Project.find(
    {
      owner_ref: userId,
      trashed: { $ne: userId },
      deletedAt: null,
    },
    { name: 1, overleaf: 1 }
  )
    .lean()
    .exec()

  return projects.map(project => ({
    id: String(project._id),
    name: project.name || 'project',
    historyId:
      (project.overleaf && project.overleaf.history && project.overleaf.history.id) ||
      null,
  }))
}

/**
 * @param {string} userId
 */
async function installationToken(userId, binding) {
  const config = Settings.githubSync
  return createInstallationToken({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: binding.installation_id,
    apiBaseUrl: config.apiBaseUrl,
  })
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function page(req, res, next) {
  try {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const binding = await loadBinding(userId)
    const projects = await loadProjects(userId)
    const csrf = res.locals.csrfToken
    const message = escapeHtml(req.query.message || '')
    const error = escapeHtml(req.query.error || '')

    const status = binding
      ? `<p><strong>Bound repository:</strong> ${escapeHtml(
          binding.repo_owner
        )}/${escapeHtml(binding.repo_name)} (branch ${escapeHtml(
          binding.branch || 'main'
        )})<br>
         <strong>Last sync:</strong> ${escapeHtml(
           binding.last_synced_at
             ? new Date(binding.last_synced_at).toISOString()
             : 'never'
         )}<br>
         <strong>Last pushed commit:</strong> ${escapeHtml(
           binding.last_pushed_sha || 'none'
         )}</p>`
      : '<p>No repository bound yet.</p>'

    res.type('text/html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>GitHub Sync</title>
<style>body{font-family:sans-serif;max-width:44rem;margin:3rem auto;line-height:1.5}
input{margin:.2rem 0 .8rem;padding:.3rem;width:100%}
button{padding:.4rem 1rem;margin-right:.5rem}</style></head>
<body>
<h1>GitHub Sync</h1>
${message ? `<p style="color:#0a0">${message}</p>` : ''}
${error ? `<p style="color:#a00">${error}</p>` : ''}
${status}
<p>${projects.length} project(s) will be exported to <code>projects/&lt;id&gt;-&lt;slug&gt;/</code>.</p>

<h2>Bind repository</h2>
<form method="post" action="/user/github-sync/bind">
  <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
  <label>GitHub App installation id<input name="installation_id"></label>
  <label>Repository owner<input name="repo_owner" placeholder="Ayanami0-39"></label>
  <label>Repository name<input name="repo_name" placeholder="overleaf-projects"></label>
  <button type="submit">Bind</button>
</form>

<h2>Sync</h2>
<form method="post" action="/user/github-sync/sync">
  <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Sync now</button>
</form>


<h2>Pull from GitHub</h2>
<p><strong>Overwrites</strong> matching files in your Overleaf projects with the
repository content. Files that only exist in Overleaf are kept.</p>
<form method="post" action="/user/github-sync/pull" onsubmit="return confirm('Overwrite matching files in Overleaf with the GitHub repository content?')">
  <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
  <button type="submit" class="danger">Pull from GitHub</button>
</form>

<h2>Unbind</h2>
<form method="post" action="/user/github-sync/unbind">
  <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Remove binding</button>
</form>
</body></html>`)
  } catch (err) {
    next(err)
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function status(req, res, next) {
  try {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const binding = await loadBinding(userId)
    const projects = await loadProjects(userId)
    res.json({
      bound: Boolean(binding),
      binding: binding
        ? {
            installation_id: binding.installation_id,
            repo_owner: binding.repo_owner,
            repo_name: binding.repo_name,
            branch: binding.branch || 'main',
            last_pushed_sha: binding.last_pushed_sha,
            last_synced_at: binding.last_synced_at,
          }
        : null,
      project_count: projects.length,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function bind(req, res, next) {
  try {
    const userId = SessionManager.getLoggedInUserId(req.session)
    logger.info({ userId }, 'github-sync: bind requested')
    const installationId = String(req.body.installation_id || '').trim()
    const owner = String(req.body.repo_owner || '').trim()
    const repo = String(req.body.repo_name || '').trim()

    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return respond(req, res, 400, { message: 'invalid installation id' })
    }
    if (!REPO_PART_PATTERN.test(owner) || !REPO_PART_PATTERN.test(repo)) {
      return respond(req, res, 400, {
        message: 'invalid repository owner or name',
      })
    }

    const config = Settings.githubSync
    const { token } = await createInstallationToken({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId,
      apiBaseUrl: config.apiBaseUrl,
    })
    const repository = await assertRepositoryAccess({
      token,
      owner,
      repo,
      apiBaseUrl: config.apiBaseUrl,
    })

    await GitHubSyncBinding.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          installation_id: installationId,
          repo_owner: owner,
          repo_name: repo,
          branch: repository.default_branch || 'main',
        },
        $setOnInsert: { last_pushed_sha: null, projects: [] },
      },
      { upsert: true, new: true }
    ).exec()

    logger.info(
      { userId, owner, repo, installationId },
      'github-sync: binding created'
    )
    respond(req, res, 200, { ok: true, repository: repository.full_name })
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return respond(req, res, 400, { message: err.message })
    }
    next(err)
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function sync(req, res, next) {
  try {
    const userId = String(SessionManager.getLoggedInUserId(req.session))
    logger.info({ userId }, 'github-sync: sync requested')
    const binding = await loadBinding(userId)
    if (!binding) {
      return respond(req, res, 409, {
        message: 'bind a repository before syncing',
      })
    }

    res.setTimeout(10 * 60 * 1000)

    const result = await withUserLock(userId, async () => {
      const { token } = await installationToken(userId, binding)
      const projects = await loadProjects(userId)
      const summary = await syncUser({
        userId,
        binding,
        projects,
        token,
      })

      await GitHubSyncBinding.updateOne(
        { user_id: userId },
        {
          $set: {
            last_pushed_sha: summary.commitSha || binding.last_pushed_sha,
            last_synced_at: new Date(),
            projects: summary.projects.map(project => ({
              project_id: project.id,
              content_hash: project.hash,
              synced_at: project.skipped ? null : new Date(),
            })),
          },
        }
      ).exec()
      return summary
    })

    logger.info({ userId, ...result, projects: undefined }, 'github-sync: synced')
    respond(req, res, 200, {
      ok: true,
      pushed: result.pushed,
      commit: result.commitSha,
      projects: result.projectCount,
      changed: result.changedProjects,
    })
  } catch (/** @type {any} */ err) {
    if (err instanceof SyncConflictError) {
      return respond(req, res, 409, { message: err.message })
    }
    if (err instanceof GitHubApiError) {
      return respond(req, res, 502, { message: err.message })
    }
    next(err)
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function unbind(req, res, next) {
  try {
    const userId = SessionManager.getLoggedInUserId(req.session)
    await GitHubSyncBinding.deleteOne({ user_id: userId }).exec()
    respond(req, res, 200, { ok: true })
  } catch (err) {
    next(err)
  }
}


/**
 * Serves the small dashboard integration script. It is static and readable by
 * any logged-in user, so it deliberately skips the binding lookup.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function uiScript(req, res) {
  res.type('application/javascript')
  res.sendFile(Path.join(import.meta.dirname, '..', 'public', 'ui.js'))
}

/**
 * Copy the bound repository back into the Overleaf projects. Destructive: local
 * content of the same path is replaced. Files that only exist in Overleaf are
 * kept.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function pull(req, res, next) {
  try {
    const userId = String(SessionManager.getLoggedInUserId(req.session))
    const binding = await loadBinding(userId)
    if (!binding) {
      return respond(req, res, 409, {
        message: 'bind a repository before pulling',
      })
    }

    res.setTimeout(10 * 60 * 1000)
    const result = await withUserLock(userId, async () => {
      const { token } = await installationToken(userId, binding)
      return pullUser({
        userId,
        binding,
        token,
        rootDirectory: Settings.githubSync.rootDirectory,
      })
    })

    logger.info({ userId, ...result }, 'github-sync: pulled')
    respond(req, res, 200, { ok: true, ...result })
  } catch (/** @type {any} */ err) {
    if (err instanceof GitHubApiError) {
      return respond(req, res, 502, { message: err.message })
    }
    next(err)
  }
}

export default {
  ensureEnabled,
  uiScript,
  page,
  status,
  bind,
  sync,
  pull,
  unbind,
}




