const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// client/package.json declares "type": "module", so this loads as ESM.
const load = () => import(pathToFileURL(path.join(__dirname, '../../client/src/utils/notify.js')).href);

const sender = { id: 'u2', username: 'alice', displayName: 'Ally' };
const base = (over = {}) => ({
  msg: { id: 'm1', chatId: 'c1', sender, content: 'hello there' },
  chat: { id: 'c1', isGroup: false, isSecret: false, name: 'Ally' },
  myUserId: 'u1',
  settings: { enabled: true, previews: true },
  tabVisible: false,
  activeChatId: null,
  ...over,
});

describe('notificationFor', () => {
  it('stays silent when notifications are off', async () => {
    const { notificationFor } = await load();
    assert.equal(notificationFor(base({ settings: { enabled: false, previews: true } })), null);
  });

  it('never notifies for my own messages or deleted ones', async () => {
    const { notificationFor } = await load();
    assert.equal(notificationFor(base({ myUserId: 'u2' })), null);
    assert.equal(notificationFor(base({ msg: { ...base().msg, deleted: true } })), null);
  });

  it("doesn't interrupt a chat I'm already looking at — but does if the tab is hidden", async () => {
    const { notificationFor } = await load();
    assert.equal(notificationFor(base({ tabVisible: true, activeChatId: 'c1' })), null);
    assert.ok(notificationFor(base({ tabVisible: false, activeChatId: 'c1' })));
    assert.ok(notificationFor(base({ tabVisible: true, activeChatId: 'other-chat' })));
  });

  it('titles private chats by sender and groups by "sender in Group"', async () => {
    const { notificationFor } = await load();
    assert.equal(notificationFor(base()).title, 'Ally');
    assert.equal(notificationFor(base({ chat: { id: 'c1', isGroup: true, isSecret: false, name: 'Team' } })).title, 'Ally in Team');
    assert.equal(notificationFor(base({ msg: { ...base().msg, sender: { id: 'u2', username: 'alice' } } })).title, 'alice');
    assert.equal(notificationFor(base()).tag, 'c1');
  });

  it('previews Cloud text (truncated), attachments, or nothing when previews are off', async () => {
    const { notificationFor } = await load();
    assert.equal(notificationFor(base()).body, 'hello there');
    assert.equal(notificationFor(base({ msg: { ...base().msg, content: 'x'.repeat(300) } })).body.length, 101);
    assert.equal(notificationFor(base({ msg: { ...base().msg, content: null, attachment: { url: '/uploads/a.bin' } } })).body, '📎 Attachment');
    assert.equal(notificationFor(base({ settings: { enabled: true, previews: false } })).body, 'New message');
  });

  it("NEVER puts Secret Chat text into the OS notification centre, whatever the settings", async () => {
    const { notificationFor } = await load();
    for (const previews of [true, false]) {
      const note = notificationFor(base({ chat: { id: 'c1', isGroup: false, isSecret: true, name: 'Ally' }, settings: { enabled: true, previews } }));
      assert.equal(note.body, '🔒 New message');
      assert.ok(!JSON.stringify(note).includes('hello there'));
    }
  });
});

describe('notification settings storage', () => {
  const fakeStorage = (initial) => {
    const data = new Map(initial ? [['unisontalk:notifications', initial]] : []);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  };

  it('defaults to off with previews on, and round-trips', async () => {
    const { loadNotifySettings, saveNotifySettings } = await load();
    const storage = fakeStorage();
    assert.deepEqual(loadNotifySettings(storage), { enabled: false, previews: true });
    saveNotifySettings({ enabled: true, previews: false }, storage);
    assert.deepEqual(loadNotifySettings(storage), { enabled: true, previews: false });
  });

  it('survives corrupt or unavailable storage', async () => {
    const { loadNotifySettings, saveNotifySettings } = await load();
    assert.deepEqual(loadNotifySettings(fakeStorage('{not json')), { enabled: false, previews: true });
    assert.deepEqual(loadNotifySettings(undefined), { enabled: false, previews: true });
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.doesNotThrow(() => saveNotifySettings({ enabled: true }, broken));
    assert.deepEqual(loadNotifySettings(broken), { enabled: false, previews: true });
  });
});
