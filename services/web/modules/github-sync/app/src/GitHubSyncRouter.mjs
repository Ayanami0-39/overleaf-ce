import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import GitHubSyncController from './GitHubSyncController.mjs'

const rateLimiters = {
  bind: new RateLimiter('github-sync-bind', { points: 10, duration: 60 * 60 }),
  sync: new RateLimiter('github-sync-sync', { points: 12, duration: 60 * 60 }),
}

export default {
  /**
   * @param {any} webRouter
   */
  apply(webRouter) {
    webRouter.get(
      '/user/github-sync/ui.js',
      GitHubSyncController.uiScript
    )
    webRouter.get(
      '/user/github-sync',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      GitHubSyncController.page
    )
    webRouter.get(
      '/user/github-sync/status',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      GitHubSyncController.status
    )
    webRouter.post(
      '/user/github-sync/bind',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      RateLimiterMiddleware.rateLimit(rateLimiters.bind),
      GitHubSyncController.bind
    )
    webRouter.post(
      '/user/github-sync/sync',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      RateLimiterMiddleware.rateLimit(rateLimiters.sync),
      GitHubSyncController.sync
    )
    webRouter.post(
      '/user/github-sync/pull/preview',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      RateLimiterMiddleware.rateLimit(rateLimiters.bind),
      GitHubSyncController.pullPreview
    )
    webRouter.post(
      '/user/github-sync/pull',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      RateLimiterMiddleware.rateLimit(rateLimiters.bind),
      GitHubSyncController.pull
    )
    webRouter.post(
      '/user/github-sync/unbind',
      AuthenticationController.requireLogin(),
      GitHubSyncController.ensureEnabled,
      GitHubSyncController.unbind
    )
  },
}

