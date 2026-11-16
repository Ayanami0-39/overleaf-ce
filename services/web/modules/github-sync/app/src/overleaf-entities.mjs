// @ts-check

// Pure helpers for normalising Overleaf entity listings. Kept free of host
// imports so the build-time compatibility check can exercise them without a
// database connection.

/**
 * `getAllEntities` has shipped two shapes: an array of `{ path, doc }` /
 * `{ path, file }` entries (6.3.x) and a map keyed by path. Both are accepted.
 *
 * @param {any} entities
 * @returns {{ docs: Map<string, any>, files: Map<string, any> }}
 */
export function normalizeEntities(entities) {
  /** @type {Map<string, any>} */
  const docs = new Map()
  /** @type {Map<string, any>} */
  const files = new Map()
  if (!entities) return { docs, files }

  const collect = (raw, target) => {
    if (!raw) return
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry && entry.path) {
          target.set(entry.path, entry.doc ?? entry.file)
        }
      }
      return
    }
    if (typeof raw === 'object') {
      for (const [path, value] of Object.entries(raw)) {
        target.set(path, value)
      }
    }
  }

  collect(entities.docs, docs)
  collect(entities.files, files)
  return { docs, files }
}

export default { normalizeEntities }
