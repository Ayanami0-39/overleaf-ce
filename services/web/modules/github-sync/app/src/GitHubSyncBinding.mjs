// @ts-check

import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * Per-project bookkeeping. `content_hash` is a stable digest of the files we
 * export for a project, so an unchanged project can be skipped cheaply and the
 * commit message can tell apart what really changed.
 */
const ProjectSyncStateSchema = new Schema(
  {
    project_id: { type: Schema.Types.ObjectId, required: true },
    content_hash: { type: String, default: null },
    synced_at: { type: Date, default: null },
  },
  { _id: false }
)

/**
 * One binding per Overleaf user: which GitHub App installation and which
 * repository the user's projects are pushed to.
 *
 * There is exactly one row per user; `last_pushed_sha` is our notion of "the
 * remote is still at the commit we produced", which is what makes the next push
 * safe to attempt without clobbering somebody else's commits.
 */
const GitHubSyncBindingSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    installation_id: { type: String, required: true },
    repo_owner: { type: String, required: true },
    repo_name: { type: String, required: true },
    branch: { type: String, default: 'main' },
    last_pushed_sha: { type: String, default: null },
    last_synced_at: { type: Date, default: null },
    projects: { type: [ProjectSyncStateSchema], default: [] },
  },
  { timestamps: true, collection: 'githubSyncBindings' }
)

export default mongoose.models.GitHubSyncBinding ||
  mongoose.model('GitHubSyncBinding', GitHubSyncBindingSchema)
