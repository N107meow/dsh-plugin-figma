/**
 * P1 semantics: components, component sets, styles, and the style references a
 * node carries.
 *
 * Two behaviours here are the whole point of the phase, and both are the kind
 * that fail quietly:
 *
 * 1. **Variant data exists only in the name.** Measured on a real file,
 *    `componentPropertyDefinitions` and `componentSetId` are absent from variant
 *    components and `componentProperties` is absent from their instances. A
 *    parser that expects structured fields finds nothing and reports nothing.
 * 2. **A node's `styles` map is the only link from a layer to a published
 *    style.** Dropping it — which P0 did — makes "which style does this use?"
 *    unanswerable from any other field.
 *
 * @module dsh-plugin-figma/test/core/component-semantics
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseVariantName,
  projectComponents,
  projectComponentSets,
  projectNode,
  projectNodeTree,
  projectStyleRefs,
  projectStyles,
} from '../../src/core/projection.js'

// ---------------------------------------------------------------- variant parsing

test('variant names parse into a base and their properties', () => {
  const cases = [
    // [input, expected]
    ['Card/Ratio=2:3', { base: 'Card', variants: { Ratio: '2:3' } }],
    ['Card/Ratio=2:2', { base: 'Card', variants: { Ratio: '2:2' } }],
    ['A/B=1', { base: 'A', variants: { B: '1' } }],
    ['A/B=1/C=2', { base: 'A', variants: { B: '1', C: '2' } }],
    ['A/B/C=1', { base: 'A/B', variants: { C: '1' } }],
    ['Card/Size=Large/State=Hover', { base: 'Card', variants: { Size: 'Large', State: 'Hover' } }],
    // A name with no variant syntax is just a name.
    ['A', undefined],
    ['A/B', undefined],
    ['A=B', undefined],
    ['', undefined],
    ['/', undefined],
    ['A/B=', undefined],
    ['A/=1', undefined],
    ['=1', undefined],
    ['A//B=1', { base: 'A/', variants: { B: '1' } }],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(parseVariantName(input), expected, `input: ${JSON.stringify(input)}`)
  }
})

test('variant parsing never throws, whatever it is handed', () => {
  for (const input of [undefined, null, 42, {}, [], true, Symbol('x'), () => {}]) {
    assert.doesNotThrow(() => parseVariantName(input))
    assert.equal(parseVariantName(input), undefined)
  }
})

test('a later duplicate property wins, and property order follows the name', () => {
  assert.deepEqual(parseVariantName('A/B=1/C=2/B=3'), { base: 'A', variants: { B: '3', C: '2' } })
})

// ---------------------------------------------------------------- components

test('components project from the file payload map, with variants parsed out', () => {
  const projected = projectComponents({
    components: {
      '21:22': { key: 'k'.repeat(40), name: 'Card/Ratio=2:3', description: '', remote: false },
      '23:24': { key: 'j'.repeat(40), name: 'Card/Ratio=2:2', remote: false },
    },
  })
  assert.equal(projected.total, 2)
  assert.deepEqual(projected.components[0], {
    id: '21:22',
    name: 'Card/Ratio=2:3',
    key: 'k'.repeat(40),
    remote: false,
    base: 'Card',
    variants: { Ratio: '2:3' },
  })
  assert.deepEqual(projected.components[1].variants, { Ratio: '2:2' })
  // An empty description is an absent value, not information.
  assert.equal('description' in projected.components[0], false)
})

test('a component name with no variant syntax keeps its name and gains no variants field', () => {
  const projected = projectComponents({ components: { '1:1': { name: 'PlainButton' } } })
  assert.deepEqual(projected.components[0], { id: '1:1', name: 'PlainButton' })
})

test('the dedicated-endpoint shape is NOT read, so published-only resources never masquerade as local ones', () => {
  // Measured: `/files/:key/components` answers [] for a file whose local
  // components exist, because it lists only what a team published. Reading that
  // shape here would produce exactly the wrong answer.
  const projected = projectComponents({ meta: { components: [{ id: '2:1', name: 'Published' }] } })
  assert.deepEqual(projected, { components: [], total: 0 })
})

test('component and style projectors tolerate empty, missing, null, and non-object maps', () => {
  for (const raw of [undefined, null, {}, { components: null }, { components: [] }, { components: 'nope' }, 42, 'x']) {
    assert.deepEqual(projectComponents(raw), { components: [], total: 0 }, `components: ${JSON.stringify(raw)}`)
    assert.deepEqual(projectComponentSets(raw), { componentSets: [], total: 0 }, `componentSets: ${JSON.stringify(raw)}`)
    assert.deepEqual(projectStyles(raw), { styles: [], total: 0 }, `styles: ${JSON.stringify(raw)}`)
  }
  assert.deepEqual(projectComponents({ components: { '1:1': null, '1:2': 'nope' } }), { components: [], total: 0 })
})

test('an empty component set list is a normal answer, not a failure', () => {
  assert.deepEqual(projectComponentSets({ componentSets: {} }), { componentSets: [], total: 0 })
})

test('component sets project their identity fields', () => {
  const projected = projectComponentSets({
    componentSets: { '33:34': { key: 's'.repeat(40), name: 'Card', description: 'Card variants', remote: false } },
  })
  assert.deepEqual(projected.componentSets, [
    { id: '33:34', name: 'Card', key: 's'.repeat(40), description: 'Card variants', remote: false },
  ])
})

// ---------------------------------------------------------------- styles

test('styles project the styleType discriminant, not type', () => {
  const projected = projectStyles({
    styles: { '29:30': { key: 'b'.repeat(40), name: 'Surface', styleType: 'FILL', remote: false, description: 'test' } },
  })
  assert.equal(projected.total, 1)
  assert.deepEqual(projected.styles[0], {
    id: '29:30',
    name: 'Surface',
    styleType: 'FILL',
    key: 'b'.repeat(40),
    description: 'test',
    remote: false,
  })
})

test('a style carrying only `type` reports no styleType, because the API populates styleType', () => {
  const projected = projectStyles({ styles: { '1:1': { name: 'Odd', type: 'FILL' } } })
  assert.equal('styleType' in projected.styles[0], false)
  assert.equal('type' in projected.styles[0], false)
})

// ---------------------------------------------------------------- node style references

test('a node style reference resolves to a name when the response carried the style table', () => {
  const index = new Map([['29:30', { name: 'Surface', styleType: 'FILL' }]])
  const node = projectNode({ id: '31:32', name: 'Bg', type: 'RECTANGLE', styles: { fill: '29:30' } }, { styleIndex: index })
  assert.deepEqual(node.styles, { fill: { id: '29:30', name: 'Surface', styleType: 'FILL' } })
})

test('an unresolvable style reference keeps its id rather than being dropped or guessed', () => {
  const node = projectNode({ id: '1:1', name: 'n', type: 'RECTANGLE', styles: { fill: '9:9' } })
  assert.deepEqual(node.styles, { fill: { id: '9:9' } })
})

test('a node with no styles map gains no styles field', () => {
  assert.equal('styles' in projectNode({ id: '1:1', name: 'n', type: 'FRAME' }), false)
  assert.equal('styles' in projectNode({ id: '1:1', name: 'n', type: 'FRAME', styles: {} }), false)
  assert.equal('styles' in projectNode({ id: '1:1', name: 'n', type: 'FRAME', styles: { fill: '' } }), false)
})

test('style reference projection ignores non-object maps and non-string ids', () => {
  assert.equal(projectStyleRefs(null, undefined), undefined)
  assert.equal(projectStyleRefs([], undefined), undefined)
  assert.equal(projectStyleRefs({ fill: 42 }, undefined), undefined)
  // A style table entry that is not an object cannot name anything, so the
  // reference falls back to its id rather than inventing a name.
  assert.deepEqual(projectStyleRefs({ fill: '1:1' }, new Map([['1:1', null]])), { fill: { id: '1:1' } })
})

test('node style references resolve from the style table shipped in the same response', () => {
  // /v1/files/:key puts the style map at the top level.
  const fileShape = projectNodeTree({
    document: { id: '0:1', name: 'Page', type: 'CANVAS', children: [{ id: '31:32', name: 'Bg', type: 'RECTANGLE', styles: { fill: '29:30' } }] },
    styles: { '29:30': { name: 'Surface', styleType: 'FILL' } },
  })
  assert.deepEqual(fileShape.roots[0].children[0].styles, { fill: { id: '29:30', name: 'Surface', styleType: 'FILL' } })

  // /v1/files/:key/nodes carries one style map per requested node.
  const nodesShape = projectNodeTree({
    nodes: {
      '31:32': {
        document: { id: '31:32', name: 'Bg', type: 'RECTANGLE', styles: { fill: '29:30' } },
        styles: { '29:30': { name: 'Surface', styleType: 'FILL' } },
      },
    },
  })
  assert.deepEqual(nodesShape.roots[0].styles, { fill: { id: '29:30', name: 'Surface', styleType: 'FILL' } })
})

test('an instance keeps its componentId, which is the only link to the component it uses', () => {
  const node = projectNode({ id: '25:26', name: 'Card/Ratio=2:2', type: 'INSTANCE', componentId: '23:24' })
  assert.equal(node.componentId, '23:24')
})
