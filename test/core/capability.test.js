/**
 * The capability table and its contract.
 *
 * The read-only assertion is the load-bearing test here: it is the mechanism
 * that keeps "this plugin never writes to Figma" true after the people who
 * wrote it have moved on.
 *
 * @module dsh-plugin-figma/test/core/capability
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  READ_ONLY_METHOD,
  assertReadOnly,
  buildPath,
  buildQuery,
  cacheKeyFor,
  describeCapability,
  findSpec,
  validateArgs,
  validateSpec,
  validateSpecs,
} from '../../src/core/capability.js'
import { ReadOnlyViolationError } from '../../src/core/errors.js'
import { ALL_OP_NAMES, ALL_SPECS } from '../../src/core/specs/index.js'
import { fileNodes } from '../../src/core/specs/files.js'

test('every declared capability is valid', () => {
  assert.deepEqual(validateSpecs(ALL_SPECS), [])
})

test('every declared capability is read-only', () => {
  for (const spec of ALL_SPECS) {
    assert.equal(spec.method, READ_ONLY_METHOD, `${spec.name} must be a GET`)
  }
})

test('the registry declares exactly the capabilities P0 promises', () => {
  assert.deepEqual([...ALL_OP_NAMES], ['file', 'file_nodes', 'file_meta', 'image_render'])
})

test('a non-GET capability is rejected at validation time', () => {
  const injected = { ...fileNodes, name: 'file_write', method: 'POST' }
  const problems = validateSpec(injected)
  assert.ok(
    problems.some((problem) => problem.includes('method must be "GET"')),
    `expected a method problem, got: ${problems.join('; ')}`,
  )
})

test('a cache declaration that omits a parameter is rejected', () => {
  const injected = { ...fileNodes, cache: { ttlMs: 1000, keyBy: ['fileKey', 'ids'] } }
  const problems = validateSpec(injected)
  assert.ok(problems.some((problem) => problem.includes('keyBy is missing parameter "depth"')))
})

test('a path placeholder with no declared parameter is rejected', () => {
  const injected = { ...fileNodes, path: '/v1/files/:fileKey/nodes/:extra' }
  const problems = validateSpec(injected)
  assert.ok(problems.some((problem) => problem.includes(':extra has no declared parameter')))
})

test('duplicate capability names are rejected', () => {
  const problems = validateSpecs([fileNodes, { ...fileNodes }])
  assert.ok(problems.some((problem) => problem.includes('duplicate capability name')))
})

test('paths fill their placeholders, encoded', () => {
  assert.equal(buildPath(fileNodes, { fileKey: 'abc123', ids: ['1:2'] }), '/v1/files/abc123/nodes')
  assert.equal(buildPath(fileNodes, { fileKey: 'a b', ids: ['1:2'] }), '/v1/files/a%20b/nodes')
})

test('query parameters come from declared non-path parameters, arrays comma-joined', () => {
  assert.deepEqual(buildQuery(fileNodes, { fileKey: 'abc123', ids: ['1:2', '3:4'], depth: 2 }), {
    ids: '1:2,3:4',
    depth: '2',
  })
})

test('fixed query values are merged in last', () => {
  const spec = { ...fileNodes, query: { geometry: 'paths' } }
  assert.deepEqual(buildQuery(spec, { fileKey: 'k', ids: ['1:2'] }), { ids: '1:2', geometry: 'paths' })
})

test('a required parameter that is missing produces bad_args naming the field', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.kind, 'bad_args')
  assert.equal(outcome.error.field, 'ids')
})

test('an undeclared parameter is refused rather than ignored', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k', ids: ['1:2'], nonsense: 1 })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.field, 'nonsense')
})

test('node ids are normalized: dashes become colons and duplicates collapse', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k', ids: ['101-202', '101:202', '303:404'] })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.value.ids, ['101:202', '303:404'])
})

test('a comma-separated string stands in for an id array', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k', ids: '101-202,303:404' })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.value.ids, ['101:202', '303:404'])
})

test('a malformed node id is refused with the expected spelling in the reason', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k', ids: ['Title'] })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.field, 'ids')
  assert.match(outcome.error.reason, /12:345/)
})

test('numeric strings are accepted for integer parameters, and range is enforced', () => {
  const accepted = validateArgs(fileNodes, { fileKey: 'k', ids: ['1:2'], depth: '3' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.value.depth, 3)

  const tooDeep = validateArgs(fileNodes, { fileKey: 'k', ids: ['1:2'], depth: 99 })
  assert.equal(tooDeep.ok, false)
  assert.equal(tooDeep.error.field, 'depth')
  assert.match(tooDeep.error.reason, /<= 8/)
})

test('enums are enforced', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k', ids: ['1:2'], geometry: 'curves' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error.reason, /must be one of: paths/)
})

test('declared defaults are applied', () => {
  const outcome = validateArgs(fileNodes, { fileKey: 'k', ids: ['1:2'] })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.value.depth, 2)
})

test('the cache key covers every content-affecting parameter', () => {
  const base = { fileKey: 'k', ids: ['1:2'], depth: 2 }
  const a = cacheKeyFor(fileNodes, base)
  assert.notEqual(a, cacheKeyFor(fileNodes, { ...base, depth: 3 }), 'depth must change the key')
  assert.notEqual(a, cacheKeyFor(fileNodes, { ...base, ids: ['9:9'] }), 'ids must change the key')
  assert.notEqual(a, cacheKeyFor(fileNodes, { ...base, geometry: 'paths' }), 'geometry must change the key')
  assert.notEqual(a, cacheKeyFor(fileNodes, { ...base, fileKey: 'other' }), 'fileKey must change the key')
  assert.notEqual(a, cacheKeyFor({ ...fileNodes, name: 'other_op' }, base), 'the capability must be part of the key')
})

test('id order is canonicalized, so the same request shares one entry', () => {
  const forward = cacheKeyFor(fileNodes, { fileKey: 'k', ids: ['1:2', '3:4'], depth: 2 })
  const reversed = cacheKeyFor(fileNodes, { fileKey: 'k', ids: ['3:4', '1:2'], depth: 2 })
  assert.equal(forward, reversed)
})

test('the read-only assertion refuses a non-GET capability', () => {
  const injected = { ...fileNodes, name: 'file_write', method: 'POST' }
  assert.throws(
    () => assertReadOnly(injected),
    (error) => error instanceof ReadOnlyViolationError && error.code === 'FIGMA_READ_ONLY_VIOLATION',
  )
})

test('the capability directory hides parameters until detail is full', () => {
  const names = describeCapability(fileNodes, 'names')
  assert.deepEqual(Object.keys(names).sort(), ['group', 'op', 'summary', 'weight'])
  const full = describeCapability(fileNodes, 'full')
  assert.ok(full.parameters.ids.required)
  assert.equal(full.parameters.depth.default, 2)
  assert.equal(full.method, 'GET')
})

test('capabilities are found by name', () => {
  assert.equal(findSpec(ALL_SPECS, 'file_nodes'), fileNodes)
  assert.equal(findSpec(ALL_SPECS, 'nope'), undefined)
})
