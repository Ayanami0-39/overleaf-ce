import { expect } from 'chai'

import {
  contentHash,
  isExcluded,
  safeRelativePath,
  slugify,
} from '../../app/src/ProjectExportUtils.mjs'

describe('ProjectExportUtils', function () {
  describe('safeRelativePath', function () {
    it('keeps ordinary project paths', function () {
      expect(safeRelativePath('main.tex')).to.equal('main.tex')
      expect(safeRelativePath('chapters/intro.tex')).to.equal(
        'chapters/intro.tex'
      )
    })

    it('normalises windows separators', function () {
      expect(safeRelativePath('chapters\\intro.tex')).to.equal(
        'chapters/intro.tex'
      )
    })

    it('rejects traversal and absolute paths', function () {
      expect(safeRelativePath('../evil.tex')).to.be.null
      expect(safeRelativePath('a/../../evil.tex')).to.be.null
      expect(safeRelativePath('/etc/passwd')).to.be.null
      expect(safeRelativePath('C:/windows/system32')).to.be.null
    })
  })

  describe('isExcluded', function () {
    const patterns = ['^output\\.pdf$', '\\.(aux|log)$']

    it('drops build artefacts', function () {
      expect(isExcluded('output.pdf', patterns)).to.equal(true)
      expect(isExcluded('main.aux', patterns)).to.equal(true)
      expect(isExcluded('main.log', patterns)).to.equal(true)
    })

    it('keeps sources, including nested ones', function () {
      expect(isExcluded('main.tex', patterns)).to.equal(false)
      expect(isExcluded('chapters/intro.tex', patterns)).to.equal(false)
    })

    it('always drops the git directory', function () {
      expect(isExcluded('.git/config', patterns)).to.equal(true)
    })
  })

  describe('contentHash', function () {
    it('is stable regardless of ordering input is sorted upstream', function () {
      const a = contentHash([{ path: 'a', sha256: '1' }])
      const b = contentHash([{ path: 'a', sha256: '1' }])
      expect(a).to.equal(b)
    })

    it('changes when a file changes', function () {
      const a = contentHash([{ path: 'a', sha256: '1' }])
      const b = contentHash([{ path: 'a', sha256: '2' }])
      expect(a).to.not.equal(b)
    })
  })

  describe('slugify', function () {
    it('builds a safe directory name', function () {
      expect(slugify('My Proposal: 2026!')).to.equal('my-proposal-2026')
      expect(slugify('')).to.equal('project')
      expect(slugify('---')).to.equal('project')
    })
  })
})
