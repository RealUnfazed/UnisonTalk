const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeUsernameBase } = require('../../server/utils/username');

describe('sanitizeUsernameBase (SSO display name -> valid username)', () => {
  const VALID = /^[a-zA-Z0-9_]{3,24}$/;

  it('always produces something the User schema accepts', () => {
    const inputs = ['José García', 'Alireza', 'a', 'ab', '', null, undefined, '田中太郎', 'سلام', 'user@example.com',
      'X Æ A-12', '   spaces   ', '😀😀😀', 'ThisIsAVeryLongDisplayNameThatExceedsLimits', '__', 123];
    for (const input of inputs) {
      const out = sanitizeUsernameBase(input);
      assert.match(out, VALID, `input ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
  });

  it('keeps recognisable names readable', () => {
    assert.equal(sanitizeUsernameBase('José García'), 'JoseGarcia');
    assert.equal(sanitizeUsernameBase('Alireza'), 'Alireza');
    assert.equal(sanitizeUsernameBase('a_b'), 'a_b');
    assert.equal(sanitizeUsernameBase('user@example.com'), 'userexamplecom');
  });

  it('falls back sensibly when nothing usable is left', () => {
    assert.equal(sanitizeUsernameBase('田中太郎'), 'user');
    assert.equal(sanitizeUsernameBase(''), 'user');
    assert.equal(sanitizeUsernameBase(null), 'user');
    assert.equal(sanitizeUsernameBase('a'), 'auser');
  });

  it('truncates long names to 20 chars, leaving room for a numeric suffix', () => {
    assert.equal(sanitizeUsernameBase('x'.repeat(50)).length, 20);
  });
});
