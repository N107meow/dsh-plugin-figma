/**
 * URL and node-id parsing.
 *
 * The link shapes here were taken from real Figma documents, but every file key
 * is **synthetic**: a real key identifies someone's file, and a test fixture is
 * not a place to publish one. The parser has no notion of which keys exist, so
 * a 22-character placeholder exercises exactly the same code path.
 *
 * @module dsh-plugin-figma/test/core/url
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeNodeId, parseFigmaUrl } from '../../src/core/url.js'

test('parses a design link with a dash node id and a tracking parameter', () => {
  const target = parseFigmaUrl('https://www.figma.com/design/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/Synthetic%20Document?node-id=0-1&t=abc123')
  assert.deepEqual(target, { fileKey: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H', nodeId: '0:1' })
})

test('parses a link whose document name is percent-encoded', () => {
  const target = parseFigmaUrl(
    'https://www.figma.com/design/Zz9Yy8Xx7Ww6Vv5Uu4Tt3S/01%20%E5%85%AC%E4%BC%97%E5%8F%B7?node-id=2-3&t=xyz',
  )
  assert.deepEqual(target, { fileKey: 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3S', nodeId: '2:3' })
})

test('covers every design path segment Figma uses', () => {
  for (const segment of ['file', 'design', 'board', 'proto', 'slides']) {
    const target = parseFigmaUrl(`https://www.figma.com/${segment}/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/Name?node-id=12-345`)
    assert.deepEqual(target, { fileKey: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H', nodeId: '12:345' }, `segment ${segment}`)
  }
})

test('accepts a link without a scheme and ignores unrelated query parameters', () => {
  const target = parseFigmaUrl('www.figma.com/design/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/Name?t=zzz&page-id=0%3A1&node-id=5-6')
  assert.deepEqual(target, { fileKey: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H', nodeId: '5:6' })
})

test('accepts a percent-encoded node id, which is what a browser address bar shows', () => {
  const target = parseFigmaUrl('https://www.figma.com/design/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/Name?node-id=7%3A8')
  assert.deepEqual(target, { fileKey: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H', nodeId: '7:8' })
})

test('accepts a bare file key', () => {
  assert.deepEqual(parseFigmaUrl('Aa1Bb2Cc3Dd4Ee5Ff6Gg7H'), { fileKey: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H', nodeId: undefined })
})

test('accepts a bare node id in either spelling', () => {
  assert.deepEqual(parseFigmaUrl('12:345'), { fileKey: undefined, nodeId: '12:345' })
  assert.deepEqual(parseFigmaUrl('12-345'), { fileKey: undefined, nodeId: '12:345' })
})

test('returns undefined rather than throwing for anything that is not a Figma target', () => {
  for (const input of [
    'https://example.com/design/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/Name?node-id=1-2',
    'https://www.figma.com/files/team/12345',
    'https://www.figma.com/design/',
    'not a url at all',
    '',
    '   ',
    'https://www.figma.com/community/file/12345',
  ]) {
    assert.equal(parseFigmaUrl(input), undefined, `input: ${JSON.stringify(input)}`)
  }
  assert.equal(parseFigmaUrl(/** @type {any} */ (undefined)), undefined)
  assert.equal(parseFigmaUrl(/** @type {any} */ (42)), undefined)
})

test('normalizes node ids to the API spelling', () => {
  assert.equal(normalizeNodeId('12-345'), '12:345')
  assert.equal(normalizeNodeId('12:345'), '12:345')
  assert.equal(normalizeNodeId('0-1'), '0:1')
  assert.equal(normalizeNodeId('I12:345;678:90'), undefined)
  assert.equal(normalizeNodeId('Title'), undefined)
})
