// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import Path from 'node:path'

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ args?: string[], stderr?: string, code?: number|null }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'GitError'
    this.args = details.args
    this.stderr = details.stderr
    this.code = details.code ?? null
  }
}

/**
 * @param {string} token
 * @returns {string}
 */
function basicAuthHeader(token) {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}

/**
 * Thin wrapper around the `git` CLI for one working tree.
 *
 * Every network command takes the installation token explicitly; the token is
 * passed as a one-shot `-c http.extraheader=...` option so it never lands in
 * `.git/config`, and it is never persisted by this class.
 */
export default class GitMirror {
  /**
   * @param {{ directory: string, branch?: string }} options
   */
  constructor({ directory, branch = 'main' }) {
    this.directory = directory
    this.branch = branch
  }

  /**
   * @param {string[]} args
   * @param {{ token?: string }} [options]
   * @returns {Promise<string>}
   */
  async git(args, { token } = {}) {
    // `safe.directory=*` keeps git usable when the mirror was created by a
    // different uid (for example during a manual test as root).
    const fullArgs = token
      ? [
          '-c',
          'safe.directory=*',
          '-c',
          `http.extraheader=Authorization: ${basicAuthHeader(token)}`,
          ...args,
        ]
      : ['-c', 'safe.directory=*', ...args]
    try {
      const { stdout } = await execFileAsync('git', fullArgs, {
        cwd: this.directory,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: process.env.HOME,
        },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      })
      return stdout.trim()
    } catch (/** @type {any} */ err) {
      throw new GitError(`git ${args[0]} failed: ${err.message}`, {
        args: fullArgs,
        stderr: err.stderr?.toString?.() ?? '',
        code: err.code,
      })
    }
  }

  async exists() {
    try {
      await fs.stat(Path.join(this.directory, '.git'))
      return true
    } catch {
      return false
    }
  }

  /**
   * Create the working tree if needed and point `origin` at `remoteUrl`.
   * @param {{ remoteUrl: string }} options
   */
  async ensureRepo({ remoteUrl }) {
    await fs.mkdir(this.directory, { recursive: true })
    if (await this.exists()) {
      const current = await this.git(['remote', 'get-url', 'origin']).catch(
        () => null
      )
      if (current !== remoteUrl) {
        if (current == null) {
          await this.git(['remote', 'add', 'origin', remoteUrl])
        } else {
          await this.git(['remote', 'set-url', 'origin', remoteUrl])
        }
      }
      return
    }
    try {
      await this.git(['init', '-q', '-b', this.branch])
    } catch {
      // git < 2.28 has no `-b`
      await this.git(['init', '-q'])
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`])
    }
    await this.git(['remote', 'add', 'origin', remoteUrl])
  }

  /**
   * @param {{ token: string }} options
   */
  async fetch({ token }) {
    await this.git(['fetch', '--prune', '--quiet', 'origin'], { token })
  }

  /**
   * Resolve the remote branch head without requiring a fetch.
   * @param {{ token: string, branch?: string }} options
   * @returns {Promise<string|null>}
   */
  async remoteSha({ token, branch = this.branch }) {
    const out = await this.git(
      ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
      { token }
    )
    if (!out) return null
    const [sha] = out.split(/\s+/)
    return sha || null
  }

  /**
   * @returns {Promise<string|null>}
   */
  async headSha() {
    try {
      return await this.git(['rev-parse', 'HEAD'])
    } catch {
      return null
    }
  }

  /**
   * @param {string} ref
   */
  async resetHard(ref) {
    await this.git(['reset', '--hard', '--quiet', ref])
  }

  async stageAll() {
    await this.git(['add', '--all', '.'])
  }

  /**
   * @returns {Promise<boolean>}
   */
  async hasStagedChanges() {
    try {
      await this.git(['diff', '--cached', '--quiet'])
      return false
    } catch (/** @type {any} */ err) {
      // `git diff --quiet` exits 1 when there are differences.
      if (err instanceof GitError && err.code === 1) return true
      throw err
    }
  }

  /**
   * @param {{ message: string, authorName: string, authorEmail: string }} options
   * @returns {Promise<string|null>}
   */
  async commit({ message, authorName, authorEmail }) {
    await this.git([
      '-c',
      `user.name=${authorName}`,
      '-c',
      `user.email=${authorEmail}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--message',
      message,
    ])
    return this.headSha()
  }

  /**
   * @param {{ token: string, branch?: string }} options
   */
  async push({ token, branch = this.branch }) {
    await this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], {
      token,
    })
  }
}

