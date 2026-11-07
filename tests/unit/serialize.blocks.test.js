// Needs `npm install` (the serializers construct a Mongoose model) but no database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { serializeUser } = require('../../server/utils/serialize');

const id = (s) => ({ toString: () => s });
const user = (over = {}) => ({ _id: id('u1'), username: 'bob', isOnline: true, lastSeen: new Date('2026-01-01'), ...over });

describe('serializeUser — blocking', () => {
  it('hides online status and last seen from someone the account has blocked', () => {
    const s = serializeUser(user({ blocked: [id('viewer')] }), 'viewer');
    assert.equal(s.isOnline, false);
    assert.equal(s.lastSeen, null);
  });

  it('is unaffected for everyone else — and blocking is directional', () => {
    const blocksViewer = user({ blocked: [id('viewer')] });
    assert.equal(serializeUser(blocksViewer, 'someone-else').isOnline, true);
    assert.equal(serializeUser(user({ blocked: [] }), 'viewer').isOnline, true);
    assert.equal(serializeUser(user(), 'viewer').isOnline, true);
  });

  it('never hides an account from itself', () => {
    assert.equal(serializeUser(user({ blocked: [id('u1')] }), 'u1').isOnline, true);
  });

  it("exposes the block list and the group-invite flag only to the owner", () => {
    const u = user({ blocked: [id('x'), id('y')], privacy: { groupInvites: false } });
    const mine = serializeUser(u, 'u1');
    assert.deepEqual(mine.blockedIds, ['x', 'y']);
    assert.equal(mine.privacy.groupInvites, false);
    const theirs = serializeUser(u, 'someone-else');
    assert.ok(!('blockedIds' in theirs) && !('privacy' in theirs));
    assert.deepEqual(serializeUser(user(), 'u1').blockedIds, []);
    assert.equal(serializeUser(user(), 'u1').privacy.groupInvites, true);
  });
});
