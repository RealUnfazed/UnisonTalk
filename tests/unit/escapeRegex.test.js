const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { escapeRegex } = require('../../server/utils/escapeRegex');

describe('escapeRegex (search input -> literal pattern)', () => {
  const matchesLiterally = (text) => new RegExp(`^${escapeRegex(text)}$`).test(text);

  it('makes every regex metacharacter match only itself', () => {
    for (const text of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', 'a.*', '(a+)+$', '[a-z]', 'a|b', 'x\\y']) {
      assert.ok(matchesLiterally(text), `should match itself: ${text}`);
    }
  });

  it('no longer behaves like a pattern', () => {
    assert.equal(new RegExp(escapeRegex('ali.*'), 'i').test('alice'), false);
    assert.equal(new RegExp(escapeRegex('a.c'), 'i').test('abc'), false);
    assert.equal(new RegExp(escapeRegex('al|bo'), 'i').test('bob'), false);
    assert.equal(new RegExp(escapeRegex('ali'), 'i').test('Alicia'), true); // ordinary substring search still works
  });

  it('leaves plain text untouched and tolerates non-strings', () => {
    assert.equal(escapeRegex('alice_99'), 'alice_99');
    assert.equal(escapeRegex(42), '42');
  });
});
