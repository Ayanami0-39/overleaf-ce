// @ts-check

import { SignJWT, importPKCS8 } from 'jose'

export class GitHubApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, body?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = details.status ?? null
    this.body = details.body ?? ''
  }
}

const API_VERSION = '2022-11-28'

/**
 * @param {string} apiBaseUrl
 * @param {string} path
 * @param {{ token?: string, method?: string, body?: any }} [options]
 */
async function githubRequest(apiBaseUrl, path, options = {}) {
  const { token, method = 'GET', body } = options
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'overleaf-github-sync',
  }
  /** @type {Record<string, string>} */ (headers)['Authorization'] = token
    ? `Bearer ${token}`
    : ''
  if (!token) delete /** @type {any} */ (headers).Authorization

  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new GitHubApiError(`GitHub API ${method} ${path} → ${res.status}`, {
      status: res.status,
      body: text.slice(0, 2000),
    })
  }
  return text ? JSON.parse(text) : null
}

/**
 * Normalize a PEM key that may have been supplied through an environment
 * variable with literal `\n` sequences.
 * @param {string} privateKey
 */
function normalizePem(privateKey) {
  return privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey
}

/**
 * Mint a short-lived (1 hour) installation access token for a GitHub App.
 *
 * The App private key never leaves the server; the returned token is scoped to
 * the installation (and therefore to the repositories the user granted).
 *
 * @param {{
 *   appId: string,
 *   privateKey: string,
 *   installationId: string,
 *   apiBaseUrl?: string,
 * }} options
 * @returns {Promise<{ token: string, expiresAt: string|null }>}
 */
export async function createInstallationToken({
  appId,
  privateKey,
  installationId,
  apiBaseUrl = 'https://api.github.com',
}) {
  if (!appId || !privateKey) {
    throw new GitHubApiError(
      'GitHub App credentials are not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)'
    )
  }
  const key = await importPKCS8(normalizePem(privateKey), 'RS256')
  const now = Math.floor(Date.now() / 1000)
  const appJwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(appId)
    .sign(key)

  const response = await fetch(
    `${apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        Authorization: `Bearer ${appJwt}`,
        'User-Agent': 'overleaf-github-sync',
      },
    }
  )
  const text = await response.text()
  if (!response.ok) {
    throw new GitHubApiError(
      `installation token request failed (${response.status})`,
      { status: response.status, body: text.slice(0, 2000) }
    )
  }
  const parsed = JSON.parse(text)
  return { token: parsed.token, expiresAt: parsed.expires_at ?? null }
}

/**
 * Look the repository up with the installation token. This is both an
 * existence check and a permission check: the token only sees repositories the
 * installation was granted.
 *
 * @param {{
 *   token: string,
 *   owner: string,
 *   repo: string,
 *   apiBaseUrl?: string,
 * }} options
 * @returns {Promise<{ fullName: string, defaultBranch: string, private: boolean }>}
 */
export async function getRepository({
  token,
  owner,
  repo,
  apiBaseUrl = 'https://api.github.com',
}) {
  const data = await githubRequest(
    apiBaseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { token }
  )
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
  }
}

/**
 * Ensure the installation can actually push to the repository. A read-only
 * grant passes the existence check but must fail here, before we touch git.
 *
 * @param {{
 *   token: string,
 *   owner: string,
 *   repo: string,
 *   apiBaseUrl?: string,
 * }} options
 */
export async function assertPushPermission({
  token,
  owner,
  repo,
  apiBaseUrl = 'https://api.github.com',
}) {
  const data = await githubRequest(
    apiBaseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { token }
  )
  const canPush = data.permissions?.push === true
  if (!canPush) {
    throw new GitHubApiError(
      `the GitHub App installation cannot push to ${owner}/${repo}`,
      { status: 403 }
    )
  }
  return data
}

export default {
  createInstallationToken,
  getRepository,
  assertPushPermission,
  GitHubApiError,
}
