import assert from 'node:assert/strict';
import test from 'node:test';
import { hash, loadModule } from './helpers.mjs';

const { decodeTree } = await loadModule('src/syntax.ts');
const { createTypeScriptView } = await loadModule('src/typescript/index.ts');
function node(source, type, startIndex = 0, endIndex = source.length, children = [], isNamed = true) {
  const point = index => ({ row: source.slice(0, index).split('\n').length - 1, column: index - (source.lastIndexOf('\n', index - 1) + 1) });
  return { type, startIndex, endIndex, startPosition: point(startIndex), endPosition: point(endIndex), isNamed, hasError: false, isMissing: false, children };
}
const child = (node, field = null) => ({ field, node });

test('detached source facade preserves UTF-16 positions, UTF-8 evidence, CRLF and anonymous tokens', () => {
  const source = '\uFEFF// \u{1f680}\r\nconst \u03b1 = "\u{1f642}";\r\n';
  const start = source.indexOf('const'), name = source.indexOf('\u03b1'), value = source.indexOf('"');
  const declaration = node(source, 'variable_declarator', name, source.indexOf(';'), [
    child(node(source, 'identifier', name, name + 1), 'name'),
    child(node(source, '=', name + 2, name + 3, [], false)),
    child(node(source, 'string', value, value + 4), 'value'),
  ]);
  const raw = node(source, 'program', 1, source.length, [
    child(node(source, 'comment', 1, start - 2)),
    child(node(source, 'lexical_declaration', start, source.indexOf(';') + 1, [
      child(node(source, 'const', start, start + 5, [], false), 'kind'), child(declaration),
      child(node(source, ';', source.indexOf(';'), source.indexOf(';') + 1, [], false)),
    ])),
  ]);
  const tree = decodeTree(raw, source), root = tree.rootNode, lexical = root.child(1), variable = lexical.child(1);
  assert.equal(root.text, source.slice(1));
  assert.equal(root.namedChildCount, 2);
  assert.equal(root.child(0).nextNamedSibling, lexical);
  assert.equal(lexical.previousNamedSibling, root.child(0));
  assert.equal(variable.previousSibling.type, 'const');
  assert.equal(variable.nextSibling.type, ';');
  assert.equal(variable.parent, lexical);
  assert.equal(variable.childForFieldName('value').text, '"\u{1f642}"');
  assert.equal(variable.childForFieldName('constructor'), null);
  assert.equal(variable.fieldNameForChild(0), 'name');
  assert.equal(variable.child(999), null);
  for (const item of [tree, root, root.children, root.namedChildren, variable.startPosition, variable]) assert(Object.isFrozen(item));
  assert.throws(() => { variable.parent = null; });
  assert.throws(() => { lexical.children.push(variable); });
  raw.children[1].node.type = 'changed';
  assert.equal(lexical.type, 'lexical_declaration');
  const view = createTypeScriptView({ tree, source, sourceHash: hash(source), relativePath: 'unicode.ts', language: 'typescript' });
  assert.equal(view.state, 'complete');
  assert.equal(view.declarations.find(item => item.name === '\u03b1').kind, 'const');
  for (const item of view.nodes) {
    const span = view.span(item);
    assert.equal(Buffer.from(source).subarray(span.startByte, span.endByte).toString('utf8'), view.text(item));
  }
});

test('syntax validation rejects malformed shapes, duplicate aliases, cycles, coordinates and spans', () => {
  const source = 'abc';
  const good = () => node(source, 'program', 0, 3, [child(node(source, 'identifier'))]);
  const changes = [
    value => { value.unknown = true; }, value => { value.type = ''; }, value => { value.type = '\u03b1'; },
    value => { delete value.isNamed; }, value => { value.hasError = 0; }, value => { value.children = {}; },
    value => { value.startIndex = -0; }, value => { value.endIndex = 1.5; }, value => { value.endIndex = 4; },
    value => { value.startPosition.column = 1; }, value => { value.endPosition.row = 1; },
    value => { value.children[0].field = '__proto__\n'; }, value => { value.children[0].extra = true; },
    value => { value.children[0].node.endIndex = 4; }, value => { value.children[0].node.isMissing = true; },
    value => { value.children.push(value.children[0]); }, value => { value.children = [child(value)]; },
    value => { value.children = [child(node(source, 'identifier', 1, 2)), child(node(source, 'identifier', 0, 1))]; },
    value => { value.children[0].node.startIndex = 2; value.children[0].node.endIndex = 1; },
    value => { value.type = 'statement_block'; }, value => { value.isNamed = false; },
  ];
  for (const change of changes) {
    const value = good(); change(value);
    assert.throws(() => decodeTree(value, source), change.toString());
  }
  assert.throws(() => decodeTree(node(source, 'program', 1, 3), source), /omits source/);
  const astral = '\u{1f642}';
  assert.throws(() => decodeTree(node(astral, 'program', 0, 2, [child(node(astral, 'string', 1, 2))]), astral), /UTF-16/);
  assert.throws(() => decodeTree(node('\ud800', 'program'), '\ud800'), /Unicode/);
});

test('source, node and depth hard bounds apply before exposing a tree', () => {
  const source = 'x';
  let nested = node(source, 'identifier');
  for (let index = 0; index < 4; index++) nested = node(source, 'parenthesized_expression', 0, 1, [child(nested)]);
  const root = node(source, 'program', 0, 1, [child(nested)]);
  assert.throws(() => decodeTree(root, source, { maxDepth: 2 }), /depth limit/);
  assert.throws(() => decodeTree(root, source, { maxNodes: 3 }), /node limit/);
  assert.throws(() => decodeTree(root, source, { maxDepth: 257 }));
  assert.throws(() => decodeTree(root, source, { maxNodes: 100001 }));
  const tooLarge = ' '.repeat(256 * 1024 + 1);
  assert.throws(() => decodeTree(node(tooLarge, 'program'), tooLarge), /Source byte limit/);
});

test('missing/error descendants cannot hide recovered syntax behind a clean parent flag', () => {
  for (const missing of [false, true]) {
    const source = 'x';
    const error = node(source, missing ? ')' : 'ERROR', 0, missing ? 0 : 1, [], !missing);
    error.isMissing = missing;
    const tree = decodeTree(node(source, 'program', 0, 1, [child(error)]), source);
    assert.equal(tree.rootNode.hasError, true);
    const view = createTypeScriptView({ tree, source, sourceHash: hash(source), relativePath: 'bad.ts', language: 'typescript' });
    assert.equal(view.state, 'unsupported');
    assert(view.diagnostics.some(item => item.code === 'typescript.parse-error'));
  }
});
