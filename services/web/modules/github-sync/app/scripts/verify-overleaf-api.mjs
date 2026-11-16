// Build-time compatibility check for the host application APIs.
//
//   node services/web/modules/github-sync/app/scripts/verify-overleaf-api.mjs
//
// It deliberately avoids importing the host modules (importing the Project
// model opens a database connection), and instead checks that the symbols the
// adapter calls still exist and that the patched view keeps its anchors.
// A failure here fails the image build instead of silently rewriting files at
// runtime after an Overleaf upgrade.

import fs from 'node:fs'

import { normalizeEntities } from '../src/overleaf-entities.mjs'

const WEB = '/overleaf/services/web'
const problems = []

/**
 * @param {string} file
 * @param {string[]} symbols
 */
function expectSymbols(file, symbols) {
  let content
  try {
    content = fs.readFileSync(`${WEB}/${file}`, 'utf8')
  } catch (err) {
    problems.push(`cannot read ${file}: ${err.message}`)
    return
  }
  for (const symbol of symbols) {
    if (!content.includes(symbol)) {
      problems.push(`${file} no longer mentions ${symbol}`)
    }
  }
}

expectSymbols('app/src/Features/Project/ProjectEntityHandler.mjs', [
  'getAllEntities',
])
expectSymbols('app/src/Features/Project/ProjectEntityUpdateHandler.mjs', [
  'upsertDocWithPath',
  'upsertFileWithPath',
])
expectSymbols('app/src/Features/Project/ProjectCreationHandler.mjs', [
  'createBlankProject',
])
expectSymbols('app/src/models/Project.mjs', ['mongoose.model'])

// normalizeEntities must understand both historical shapes.
for (const [label, raw] of [
  [
    'array',
    {
      docs: [{ path: '/main.tex', doc: { lines: ['a'] } }],
      files: [{ path: '/figs/x.png', file: { _id: 'f1' } }],
    },
  ],
  [
    'map',
    {
      docs: { '/main.tex': { lines: ['a'] } },
      files: { '/figs/x.png': { _id: 'f1' } },
    },
  ],
]) {
  const normalized = normalizeEntities(raw)
  if (!normalized.docs.has('/main.tex') || !normalized.files.has('/figs/x.png')) {
    problems.push(`normalizeEntities did not accept the ${label} shape`)
  }
}

// The dashboard template is patched at build time; the anchors must survive.
const templatePath = `${WEB}/app/views/project/list-react.pug`
try {
  const template = fs.readFileSync(templatePath, 'utf8')
  if (!template.includes('#project-list-root')) {
    problems.push(`dashboard template changed: ${templatePath}`)
  }
  if (!template.includes('/user/github-sync/ui.js')) {
    problems.push('dashboard template is missing the github-sync script tag')
  }
} catch (err) {
  problems.push(`cannot read dashboard template: ${err.message}`)
}

if (problems.length > 0) {
  console.error('github-sync: host compatibility check FAILED')
  for (const problem of problems) console.error(' -', problem)
  process.exit(1)
}

console.log('github-sync: host compatibility check OK')
