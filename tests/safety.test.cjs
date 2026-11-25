const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('keyboard navigation keeps selection at the end of a list and in an empty folder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const start = source.indexOf('function process_key(');
  const end = source.indexOf("\nconsole.log('Loading popup')", start);
  let selected = true;
  const item = {
    nextElementSibling: null,
    querySelector: () => null,
    classList: { remove() { selected = false; } },
  };
  const context = {
    console: { log() {} },
    currently_selected_elem: () => selected ? item : null,
    document: {
      getElementById: () => ({ firstChild: item }),
      querySelector: (selector) => selector === 'li.selected a'
        ? { classList: { contains: (name) => name === 'minus' } }
        : null,
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  for (const keyCode of [40, 39]) {
    assert.equal(context.process_key({ keyCode, preventDefault() {} }), true);
    assert.equal(selected, true);
  }
});

function element(tag) {
  return {
    tag, children: [], classList: { add() {} },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
  };
}

function popupFunctions() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const start = source.indexOf('const folderIcon =');
  const end = source.indexOf('\nfunction expand(', start);
  const context = {
    URL, localStorage: { deviceId: 'local' },
    document: {
      createElement: element,
      createTextNode: value => ({ textContent: value }),
      getElementById: () => ({ value: 'search' }),
    },
    hasChildren: () => false,
    expand() {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('bookmark titles and device names remain text even when highlighted', () => {
  const { generateListItem } = popupFunctions();
  const title = '<img src=x onerror=alert(1)>';
  const item = generateListItem('img', { id: 'remote|1', title, url: 'https://example.com', device: '<svg onload=alert(1)>' });
  const link = item.children[0];
  assert.equal(link.innerHTML, undefined);
  assert.equal(link.children.map(child => child.textContent).join(''), title + ' <svg onload=alert(1)>');
  assert.equal(link.href, 'https://example.com/');
  assert.equal(link.rel, 'noopener noreferrer');
});

test('executable and malformed bookmark URLs are not clickable', () => {
  const { generateListItem } = popupFunctions();
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'not a URL']) {
    const link = generateListItem('', { id: '1', title: 'example', url }).children[0];
    assert.equal(link.href, undefined);
  }
});

test('folder search retains the remote device label without injecting markup', () => {
  const { generateListItem } = popupFunctions();
  const folder = generateListItem('folder', {
    id: 'remote|folder', title: '<folder>', device: '<device>',
  }).children[0];
  assert.doesNotMatch(folder.innerHTML, /<folder>|<device>/);
  assert.equal(folder.children.map(child => child.textContent).join(''), '<folder> <device> (empty)');
});

test('a title-only bookmark change preserves its URL', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const start = source.indexOf('var getItemById');
  const end = source.indexOf('\n// Chrome emits one removal event', start);
  const context = { bookmarksToShowInTheUI: [{ id: 'a', title: 'Before', url: 'https://example.com/' }] };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const result = context.getItemById({ id: 'a', title: 'After' });
  assert.equal(result.title, 'After');
  assert.equal(result.url, 'https://example.com/');
  assert.equal(context.getItemById({ id: 'missing', title: 'Ignored' }), null);
});

test('folder removal finds local descendants without touching other devices', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const start = source.indexOf('function localSubtreeIds');
  const end = source.indexOf('\nvar sortBookmarksInTheUI', start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const entries = [
    { id: 'local|folder', parentId: 'local|root' },
    { id: 'local|nested', parentId: 'local|folder' },
    { id: 'local|bookmark', parentId: 'local|nested' },
    { id: 'local|other', parentId: 'local|root' },
    { id: 'remote|bookmark', parentId: 'local|folder' },
  ];
  assert.deepEqual(Array.from(context.localSubtreeIds('local|folder', entries, 'local')),
    ['local|folder', 'local|nested', 'local|bookmark']);
  assert.deepEqual(Array.from(context.localSubtreeIds('remote|bookmark', entries, 'local')), []);
});

test('folder removal deletes all cached local descendants from the sync store', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const helperStart = source.indexOf('function localSubtreeIds');
  const helperEnd = source.indexOf('\n// Initialize Firebase', helperStart);
  const eventStart = source.indexOf('chrome.bookmarks.onRemoved.addListener');
  const eventEnd = source.indexOf('\nfirebase.auth().onAuthStateChanged', eventStart);
  const deleted = [];
  let listener;
  const context = {
    bookmarksToShowInTheUI: [
      { id: 'local|folder', parentId: 'local|root', title: 'Folder' },
      { id: 'local|child', parentId: 'local|folder', title: 'Child' },
      { id: 'remote|child', parentId: 'local|folder', title: 'Remote' },
    ],
    localStorage: { deviceId: 'local' },
    chrome: { bookmarks: { onRemoved: { addListener(fn) { listener = fn; } } } },
    deleteRecordOnServer(id) { deleted.push(id); },
    json_encode: JSON.stringify,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart, helperEnd) + source.slice(eventStart, eventEnd), context);
  listener('folder', { node: { id: 'folder' } });
  assert.deepEqual(deleted, ['local|folder', 'local|child']);
  assert.deepEqual(context.bookmarksToShowInTheUI.map(item => item.id), ['remote|child']);
  assert.deepEqual(JSON.parse(context.localStorage.remoteBookmarks).map(item => item.id), ['remote|child']);
  listener('missing', { node: { id: 'missing' } });
  assert.deepEqual(deleted, ['local|folder', 'local|child', 'local|missing']);
  assert.deepEqual(context.bookmarksToShowInTheUI.map(item => item.id), ['remote|child']);
});

test('settings render device names as text and reject invalid sync keys', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  const controls = new Map();
  function control(id) {
    if (!controls.has(id)) {
      const node = element(id);
      node.style = {};
      node.classList = { add() {}, remove() {} };
      node.append = (...children) => node.children.push(...children);
      node.replaceChildren = (...children) => { node.children = children; };
      controls.set(id, node);
    }
    return controls.get(id);
  }
  const createElement = tag => {
    const node = element(tag);
    node.append = (...children) => node.children.push(...children);
    return node;
  };
  const stored = { remoteBookmarks: JSON.stringify([{ id: '<img onerror=alert(1)>|0', parentId: null }]) };
  const context = {
    localStorage: stored,
    document: {
      querySelector: control, getElementById: control, createElement,
      getElementsByClassName: () => [],
    },
    window: { atob }, chrome: { runtime: {} }, navigator: {}, setTimeout() {}, console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const name = control('devices-list').children[0].children[0].children[0].children[0];
  assert.equal(name.textContent, '<img onerror=alert(1)>');
  assert.equal(name.innerHTML, undefined);
  control('sync-key').value = 'not base64!';
  control('device-name').value = 'device';
  assert.doesNotThrow(() => context.save_settings());
  assert.equal(stored.passphrase, undefined);
});

test('background logging does not include bookmark records or sync identities', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const logCalls = source.match(/console\.(?:log|warn|error)\([^\n]*/g) || [];
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\b(?:node|record|user\.uid|deviceId|request\.value)\b/);
  }
});

test('sync connection handles failed requests without unhandled rejections', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const start = source.indexOf('async function connect_to_firebase');
  const end = source.indexOf('\nasync function main()', start);
  let signedIn = 0;
  let warnings = 0;
  const context = {
    localStorage: { passphrase: 'sample' },
    derive_uid_from_passphrase: async () => 'local-id',
    derive_aes_key_from_passphrase: async () => 'local-key',
    fetch: async () => { throw new Error('offline'); },
    firebase: { auth: () => ({ signInWithCustomToken: async () => { signedIn++; } }) },
    console: { warn() { warnings++; } },
    encodeURIComponent,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.connect_to_firebase();
  assert.equal(warnings, 1);
  assert.equal(signedIn, 0);
  context.fetch = async () => ({ ok: false });
  await context.connect_to_firebase();
  assert.equal(warnings, 2);
  assert.equal(signedIn, 0);
  context.fetch = async () => ({ ok: true, text: async () => 'sample-token' });
  await context.connect_to_firebase();
  assert.equal(signedIn, 1);
});
