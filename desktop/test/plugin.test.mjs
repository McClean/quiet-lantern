// Game mode desktop logic and wiring. Run: node --test desktop/test/plugin.test.mjs
// The SDK and React are stubbed by hooks.mjs; the static checks read plugin.js and the installed SDK source.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks.mjs')));
const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugin.js');
const mod = await import(pathToFileURL(PLUGIN).href);
const {
  profileUrl, resolveDrivingProfile, profileNames, initModel,
  reflexFire, reflexTick, pushActivity, HIGHLIGHT_MS, ACTIVITY_CAP,
} = mod;
const sdk = await import(pathToFileURL(path.join(here, 'stubs', 'sdk.mjs')).href);

// ---------- profile routing ----------

test('profileUrl adds ?profile= to a bare path', () => {
  assert.equal(profileUrl('/assets', 'gamer'), '/assets?profile=gamer');
});

test('profileUrl adds &profile= when the path has a query, URL-encoding the name', () => {
  assert.equal(profileUrl('/rom/chunk?i=2', 'my gamer'), '/rom/chunk?i=2&profile=my%20gamer');
});

test('profileUrl leaves the path alone when there is no profile', () => {
  assert.equal(profileUrl('/health', ''), '/health');
  assert.equal(profileUrl('/health', null), '/health');
});

test('resolveDrivingProfile keeps a stored profile that still exists', () => {
  assert.equal(resolveDrivingProfile('gamer', ['default', 'gamer']), 'gamer');
});

test('resolveDrivingProfile falls back to default when unset or deleted', () => {
  assert.equal(resolveDrivingProfile(undefined, ['default', 'gamer']), 'default');
  assert.equal(resolveDrivingProfile('deleted', ['default', 'gamer']), 'default');
});

test('profileNames reads names from route objects and plain strings', () => {
  assert.deepEqual(profileNames([{ profile: 'default' }, 'gamer', { name: 'work' }]), ['default', 'gamer', 'work']);
});

test('backendErrorMessage names the profile and the fix', () => {
  const msg = mod.backendErrorMessage('gamer');
  assert.equal(
    msg,
    "The gamer profile doesn't have the game plugin enabled. Enable 'emulator-catalog' in that profile, then Restart gateway.",
  );
});

// ---------- game files: the localhost server, not the profile-scoped REST ----------

test('gameServerUrl points at the loopback file server on the default port 47911', () => {
  assert.equal(mod.DEFAULT_FILE_PORT, 47911);
  assert.equal(mod.gameServerUrl('/library'), 'http://127.0.0.1:47911/library');
});

test('gameServerUrl honours a port that is not the default', () => {
  assert.equal(mod.gameServerUrl('/health', 5555), 'http://127.0.0.1:5555/health');
});

// Guard: romPath now takes a 16-hex title id (the file server's id), not a file name.
test('romPath builds the /rom/<titleId> route for a title id', () => {
  assert.equal(mod.romPath('3f2a9c1d8e7b6a50'), '/rom/3f2a9c1d8e7b6a50');
});

test('isGameServerHealth accepts only this plugin on the port, not any other server', () => {
  assert.equal(mod.isGameServerHealth({ ok: true, plugin: 'emulator-catalog', version: '0.1.0' }), true);
  assert.equal(mod.isGameServerHealth({ plugin: 'some-other-plugin' }), false);
  assert.equal(mod.isGameServerHealth(null), false);
});

test('serverMissingMessage gives the exact text the tile shows when the file server is down', () => {
  assert.equal(
    mod.serverMissingMessage(),
    'Game file server not running on 127.0.0.1:47911. Enable emulator-catalog in at least one profile and restart the gateway.',
  );
});

test('serverMissingMessage names the port it tried', () => {
  assert.match(mod.serverMissingMessage(5555), /127\.0\.0\.1:5555/);
});

test('game loading never goes through the profile-scoped REST for assets or ROM bytes', () => {
  const src = readFileSync(PLUGIN, 'utf8');
  assert.doesNotMatch(src, /api\(\s*['"`]\/assets/, 'assets must come from the local server');
  assert.doesNotMatch(src, /api\(\s*['"`]\/rom\//, 'ROM bytes must come from the local server');
  assert.doesNotMatch(src, /api\(\s*['"`]\/health/, 'the health check must hit the local server');
});

// ---------- in-memory model (placeholder data for the side panel) ----------

test('initModel has four demo reflexes and one long-term plus three short-term goals', () => {
  const m = initModel();
  assert.equal(m.reflexes.length, 4);
  assert.equal(typeof m.goals.long, 'string');
  assert.equal(m.goals.short.length, 3);
});

test('reflexFire highlights the row, bumps its count and stamps lastFiredAt without mutating the input', () => {
  const base = initModel();
  const id = base.reflexes[1].id;
  const next = reflexFire(base, id, 1000, 'HP low');
  const r = next.reflexes.find(x => x.id === id);
  assert.equal(r.count, 1);
  assert.equal(r.lastFiredAt, 1000);
  assert.equal(r.lastWhy, 'HP low');
  assert.equal(r.highlightUntil, 1000 + HIGHLIGHT_MS);
  assert.equal(base.reflexes[1].count, 0);
});

test('reflexTick clears a highlight only once HIGHLIGHT_MS has passed', () => {
  const base = initModel();
  const fired = reflexFire(base, base.reflexes[0].id, 1000, 'x');
  assert.ok(reflexTick(fired, 1000 + HIGHLIGHT_MS - 1).reflexes[0].highlightUntil > 0);
  assert.equal(reflexTick(fired, 1000 + HIGHLIGHT_MS).reflexes[0].highlightUntil, 0);
});

test('pushActivity keeps only the newest ACTIVITY_CAP (50) lines', () => {
  let list = [];
  for (let i = 0; i < 51; i++) list = pushActivity(list, `line ${i}`);
  assert.equal(ACTIVITY_CAP, 50);
  assert.equal(list.length, 50);
  assert.equal(list[0], 'line 1');
  assert.equal(list.at(-1), 'line 50');
});

// ---------- restart button: shown after a profile change AND when the backend is missing ----------

test('restartNeeded is true after a driving-profile change', () => {
  assert.equal(mod.restartNeeded({ needsRestart: true, backend: { state: 'idle' } }), true);
});

test('restartNeeded is true when the driving profile has no plugin, so the user can recover', () => {
  assert.equal(mod.restartNeeded({ needsRestart: false, backend: { state: 'missing' } }), true);
});

test('restartNeeded is false when the backend answers and nothing changed', () => {
  assert.equal(mod.restartNeeded({ needsRestart: false, backend: { state: 'ok' } }), false);
});

// ---------- agent command replies: the desktop half answers /pending commands ----------

test('commandReply acknowledges op=open', () => {
  const r = mod.commandReply({ id: 'c1', op: 'open' }, { open: false, backend: 'ok', loaded: false });
  assert.equal(r.ok, true);
  assert.equal(r.op, 'open');
});

test('commandReply reports game mode state for op=status', () => {
  const r = mod.commandReply({ id: 'c2', op: 'status' }, { open: true, backend: 'missing', loaded: false });
  assert.deepEqual(r, { ok: true, op: 'status', open: true, backend: 'missing', loaded: false });
});

test('commandReply refuses an unknown op with a structured error, never guesses', () => {
  const r = mod.commandReply({ id: 'c3', op: 'press' }, { open: false, backend: 'ok', loaded: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported_op');
  assert.match(r.error, /press/);
});

// ---------- registration: how the user reaches game mode ----------

function fakeCtx(stored = {}) {
  const regs = [];
  const disposed = []; // ids whose registration disposer ran
  const rests = []; // every ctx.rest call: { path, opts }
  const intervals = []; // every ctx.setInterval: { ms, stopped }
  const disposers = []; // ctx.onDispose callbacks
  return {
    regs, disposed, rests, intervals, disposers,
    source: 'plugin:emulator-catalog',
    storage: { get: (k, fallback) => (Object.hasOwn(stored, k) ? stored[k] : fallback), set() {}, remove() {} },
    register: c => { regs.push(c); return () => { disposed.push(c.id); }; },
    registerMany: () => () => {},
    registerSettingsPage: () => () => {},
    onDispose: fn => { disposers.push(fn); },
    onEvent: () => () => {},
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    setInterval: (fn, ms) => {
      const rec = { ms, stopped: false };
      intervals.push(rec);
      return () => { rec.stopped = true; };
    },
    addEventListener: () => () => {},
    rest: async (path, opts = {}) => { rests.push({ path, opts }); return {}; },
    socket: () => () => {},
  };
}

// register() attaches a message listener to window; Node has none, so give it a plain stand-in.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
// Tests never touch the real file server. fetch answers the library API (CONTRACTS §7) from fixtures.
const T = {
  a: { id: '3f2a9c1d8e7b6a50', name: 'Pokemon - FireRed Version (USA)', code: 'BPRE', headerTitle: 'POKEMON FIRE', pack: 'firered-bpre', adapter: 'mgba' },
  b: { id: 'aa11bb22cc33dd44', name: 'Advance Wars (USA)', code: 'AWRE', headerTitle: 'ADVANCE WARS', pack: null, adapter: 'mgba' },
  c: { id: 'c0ffee0000000001', name: 'Metroid Fusion (USA)', code: 'AMSE', headerTitle: 'METROID FUSION', pack: null, adapter: 'mgba' },
  d: { id: 'c0ffee0000000002', name: 'Golden Sun (USA)', code: 'AGSE', headerTitle: 'GOLDEN SUN', pack: null, adapter: 'mgba' },
  e: { id: 'c0ffee0000000003', name: 'Mario Kart Super Circuit (USA)', code: 'AMKE', headerTitle: 'MARIO KART', pack: null, adapter: 'mgba' },
};
const LIBRARY = {
  systems: [
    { id: 'gba', name: 'Game Boy Advance', adapter: 'mgba', count: 5 },
    { id: 'nes', name: 'NES', adapter: 'quicknes', count: 0 },
  ],
  unsupported: { '.sfc': 1, '.md': 1 },
};
const CATALOG = { gba: { system: 'gba', titles: [T.a, T.b, T.c, T.d, T.e] }, nes: { system: 'nes', titles: [] } };
const ADAPTERS = [
  { id: 'mgba', name: 'mGBA', buttons: ['A', 'B', 'SELECT', 'START', 'RIGHT', 'LEFT', 'UP', 'DOWN', 'R', 'L'], controls: { KeyZ: 'A' }, capabilities: ['video', 'input'], systems: ['gba'] },
];
const fetchLog = [];
const jsonReply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
globalThis.fetch = async (url, opts = {}) => {
  const { pathname } = new URL(url);
  fetchLog.push({ path: pathname, method: opts.method || 'GET' });
  if (pathname === '/health') return jsonReply({ plugin: 'emulator-catalog', version: '0.1.0', contract: 1 });
  if (pathname === '/library') return jsonReply(LIBRARY);
  if (pathname === '/adapters') return jsonReply(ADAPTERS);
  // Same shape as game_file_server: runtime.files live under core/, the binding at the adapter root.
  const core = pathname.match(/^\/core\/([a-z0-9-]+)\/(core\/[A-Za-z0-9._-]+|binding\.mjs)$/);
  if (core) return { ok: true, status: 200, text: async () => `// ${core[2]} for ${core[1]}`, arrayBuffer: async () => new Uint8Array([7, 7]).buffer };
  const cat = pathname.match(/^\/library\/([a-z0-9-]+)$/);
  if (cat) return jsonReply(CATALOG[cat[1]] || { system: cat[1], titles: [] });
  if (pathname === '/player.html') return { ok: true, status: 200, text: async () => '<!doctype html><body>player</body>' };
  if (/^\/rom\/[0-9a-f]{16}$/.test(pathname)) {
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  }
  return jsonReply({ error: 'not found' }, false);
};

// Minimal fake document: createElement('iframe') elements, body.appendChild/removeChild, counters.
function makeDocument() {
  const state = { created: 0, removed: 0 };
  const body = {
    children: [],
    appendChild(el) { this.children.push(el); el.isConnected = true; return el; },
    removeChild(el) { this.children = this.children.filter(c => c !== el); el.isConnected = false; state.removed++; return el; },
  };
  return {
    body,
    state,
    createElement(tag) {
      state.created++;
      const attrs = {};
      const el = { tagName: String(tag).toUpperCase(), style: {}, isConnected: false, focused: 0, posted: [], src: '', title: '',
        setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: k => (k in attrs ? attrs[k] : null) };
      el.contentWindow = { posted: el.posted, postMessage: msg => { el.posted.push(msg); } };
      el.focus = () => { el.focused++; };
      el.remove = () => { if (el.isConnected) body.removeChild(el); };
      return el;
    },
  };
}
function installDom() {
  const doc = makeDocument();
  globalThis.document = doc;
  window.innerWidth = 1280;
  window.innerHeight = 800;
  return doc;
}
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

test('register() offers the sidebar row, the /game route, a palette command and a status chip', () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const byArea = area => ctx.regs.filter(r => r.area === area);
  assert.ok(byArea('sidebar.nav').some(r => r.data && r.data.path === '/game'), 'sidebar row to /game');
  assert.ok(byArea('routes').some(r => r.data && r.data.path === '/game'), '/game route');
  assert.ok(byArea('palette').some(r => r.data && /game mode/i.test(r.data.label)), 'Ctrl+K "Game mode"');
  assert.ok(byArea('statusBar.right').length >= 1, 'status-bar chip');
});

test('register() does not open the side panel: it appears only in game mode', () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  assert.equal(ctx.regs.filter(r => r.area === 'panes').length, 0);
});

// ---------- Kanban model: /game is the Game Mode page itself; every entry point just navigates there ----------

// Walk a rendered element tree and collect nodes matching pred. Function components are expanded by calling
// them with their props, so a control nested inside a component (the profile dropdown) is still found.
// SDK components are stubs that render nothing, so their children are read from props instead of expanded.
const SDK_TYPES = new Set(Object.values(sdk));
const isSdk = t => SDK_TYPES.has(t);
function collect(node, pred, out = []) {
  if (Array.isArray(node)) { node.forEach(n => collect(n, pred, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) { out.push(node); return out; }
  if (typeof node.type === 'function' && !isSdk(node.type)) return collect(node.type(node.props || {}), pred, out);
  const kids = node.props ? node.props.children : undefined;
  if (kids !== undefined) collect(kids, pred, out);
  return out;
}
// The visible text of a rendered tree (function components expanded the same way as collect).
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  if (typeof node.type === 'function' && !isSdk(node.type)) return textOf(node.type(node.props || {}));
  return textOf(node.props ? node.props.children : undefined);
}

test('the /game route renders the Game Mode page itself, not a launcher placeholder', () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const route = ctx.regs.find(r => r.area === 'routes' && r.data && r.data.path === '/game');
  assert.equal(route.render().type, mod.GamePage);
});

test('the plugin ships no launcher placeholder and no Back-to-chat or Show-game buttons', () => {
  const src = readFileSync(PLUGIN, 'utf8');
  assert.doesNotMatch(src, /function Launcher|Back to chat|Show game/);
});

test('register() navigates nowhere: the sidebar row is a plain route link', () => {
  sdk.calls.length = 0;
  mod.default.register(fakeCtx());
  assert.equal(sdk.calls.some(c => c.op === 'navigate' || c.op === 'openWorkspace'), false);
});

test('every entry point navigates to /game exactly once and never opens a workspace tile or the chat root', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const entries = {
    palette: () => ctx.regs.find(r => r.area === 'palette').data.run(),
    statusbar: () => ctx.regs.find(r => r.area === 'statusBar.right').render().props.onClick(),
    agent: () => mod.runCommand({ id: 'agent-open-1', op: 'open' }),
  };
  for (const [name, run] of Object.entries(entries)) {
    sdk.calls.length = 0;
    await run();
    assert.deepEqual(sdk.calls.filter(c => c.op === 'navigate'), [{ op: 'navigate', path: '/game' }],
      `${name}: exactly one navigate('/game')`);
    assert.equal(sdk.calls.some(c => c.op === 'openWorkspace'), false, `${name}: no workspace tile`);
    assert.equal(sdk.calls.some(c => c.op === 'navigate' && c.path === '/'), false, `${name}: never the chat root`);
  }
});

test('the page header control is WorkspacePageHeaderControl with id emulator-catalog:header, holding the profile dropdown', () => {
  const page = mod.GamePage({});
  const headers = collect(page, n => n.type === sdk.WorkspacePageHeaderControl);
  assert.equal(headers.length, 1, 'one header control on the page');
  assert.equal(headers[0].props.id, 'emulator-catalog:header');
  const selects = collect(headers[0].props.children, n => n.type === sdk.Select);
  assert.equal(selects.length, 1, 'profile dropdown only: the game picker is gone');
});

// ---------- several games at once (CONTRACTS §10.1–10.4) ----------

const iframesOnBody = () => document.body.children.filter(c => c.tagName === 'IFRAME');
const sess = id => mod.gameState().sessions.find(s => s.id === id);
const slotAt = (left, top, width, height) => ({ isConnected: true, getBoundingClientRect: () => ({ left, top, width, height }) });
const replyFor = (ctx, id) => {
  const hit = ctx.rests.find(r => r.path.startsWith('/reply') && r.opts.body && r.opts.body.id === id);
  return hit ? hit.opts.body : undefined;
};
const navigates = () => sdk.calls.filter(c => c.op === 'navigate');

test('opening /game makes no /rom fetch and creates no iframe (no auto-start)', async () => {
  mod.default.register(fakeCtx());
  await mod.enterGamePage();
  assert.equal(fetchLog.filter(f => f.path.startsWith('/rom/')).length, 0, 'no ROM fetched');
  assert.equal(iframesOnBody().length, 0, 'no game frame');
  assert.equal(mod.gameState().sessions.length, 0, 'no session');
});

test('the home screen shows one card per system with count > 0 and the unsupported text', async () => {
  mod.default.register(fakeCtx());
  await mod.loadLibrary();
  const text = textOf(mod.GamePage({}));
  assert.match(text, /Game Boy Advance/);
  assert.match(text, /5 titles/);
  assert.doesNotMatch(text, /NES/, 'a system with count 0 gets no card');
  assert.match(text, /Found but not supported: \.sfc ×1, \.md ×1/);
});

test('the catalog lists each title with its name, code and pack yes or no', async () => {
  mod.default.register(fakeCtx());
  await mod.loadLibrary();
  await mod.openCatalog('gba');
  const text = textOf(mod.GamePage({}));
  assert.match(text, /Pokemon - FireRed Version \(USA\)/);
  assert.match(text, /BPRE/);
  assert.match(text, /pack yes/);
  assert.match(text, /pack no/);
});

test('clicking a title fetches /rom/<id> once and creates exactly one iframe', async () => {
  mod.default.register(fakeCtx());
  await mod.loadLibrary();
  await mod.openCatalog('gba');
  const row = collect(mod.GamePage({}), n => n.props && n.props['data-title'] === T.a.id)[0];
  await row.props.onClick();
  assert.equal(fetchLog.filter(f => f.path === `/rom/${T.a.id}`).length, 1, 'one ROM fetch');
  assert.equal(iframesOnBody().length, 1, 'one iframe');
});

test('the game iframe is sandboxed allow-scripts with the player data URL', async () => {
  mod.default.register(fakeCtx());
  const { id } = await mod.startSession(T.a);
  const frame = sess(id).iframe;
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.match(frame.src, /^data:text\/html/);
});

test('two launches give two iframes and two tabs', async () => {
  mod.default.register(fakeCtx());
  await mod.startSession(T.a);
  await mod.startSession(T.b);
  assert.equal(iframesOnBody().length, 2);
  const tabs = collect(mod.GamePage({}), n => n.props && n.props['data-tab'] !== undefined);
  assert.equal(tabs.length, 2);
});

test('switching tab moves the big slot to the chosen game without recreating any iframe', async () => {
  mod.default.register(fakeCtx());
  await mod.enterGamePage();
  const big = slotAt(100, 100, 600, 400);
  mod.attachSlot('big', big);
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  const frameA = sess(a).iframe;
  const created = document.state.created;
  const removed = document.state.removed;
  mod.selectSession(a);
  assert.equal(sess(a).iframe, frameA, 'same iframe object');
  assert.equal(document.state.created, created, 'no iframe created');
  assert.equal(document.state.removed, removed, 'no iframe removed');
  assert.equal(frameA.style.left, '100px');
  assert.equal(frameA.style.width, '600px', 'A sits in the big slot');
  assert.notEqual(sess(b).iframe.style.width, '600px', 'B no longer in the big slot');
});

test('the × on one session stops only that session and leaves the other running', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  const frameB = sess(b).iframe;
  mod.stopSession(a);
  assert.equal(iframesOnBody().length, 1, 'one iframe left');
  assert.equal(sess(a), undefined, 'A is gone');
  assert.equal(sess(b).iframe, frameB, 'B is the same iframe');
  assert.equal(frameB.isConnected, true, 'B still in the document');
});

test('sessionCap: null, zero, negative and non-numbers mean no cap; a positive number is the cap', () => {
  assert.equal(mod.sessionCap(null), null);
  assert.equal(mod.sessionCap(undefined), null);
  assert.equal(mod.sessionCap(0), null);
  assert.equal(mod.sessionCap(-3), null);
  assert.equal(mod.sessionCap('many'), null);
  assert.equal(mod.sessionCap(2), 2);
  assert.equal(mod.sessionCap(2.7), 2);
});

test('with no maxSessions setting there is no cap: five launches all start', async () => {
  mod.default.register(fakeCtx());
  for (const t of [T.a, T.b, T.c, T.d, T.e]) assert.equal((await mod.startSession(t)).ok, true);
  assert.equal(iframesOnBody().length, 5);
  const plus = collect(mod.GamePage({}), n => n.props && n.props['data-new'] !== undefined)[0];
  assert.equal(plus.props.disabled, false);
  assert.equal(textOf(plus), '+');
});

test('a maxSessions setting caps the sessions: the next launch is refused', async () => {
  mod.default.register(fakeCtx({ maxSessions: 2 }));
  assert.equal((await mod.startSession(T.a)).ok, true);
  assert.equal((await mod.startSession(T.b)).ok, true);
  const r = await mod.startSession(T.c);
  assert.equal(r.ok, false);
  assert.equal(r.error, '2 games running');
  assert.equal(iframesOnBody().length, 2);
});

test('at a maxSessions cap the + tab is disabled and reads "<n> games running"', async () => {
  mod.default.register(fakeCtx({ maxSessions: 2 }));
  await mod.startSession(T.a);
  await mod.startSession(T.b);
  const plus = collect(mod.GamePage({}), n => n.props && n.props['data-new'] !== undefined)[0];
  assert.equal(plus.props.disabled, true);
  assert.equal(textOf(plus), '2 games running');
});

test('pure: a session under 50 fps is flagged only after 5 s, and clears at 50 fps', () => {
  let st = mod.nextSlowState({ since: null, slow: false }, 30, 1000);
  assert.equal(st.slow, false);
  st = mod.nextSlowState(st, 30, 5999);
  assert.equal(st.slow, false);
  st = mod.nextSlowState(st, 30, 6000);
  assert.equal(st.slow, true);
  st = mod.nextSlowState(st, 50, 6100);
  assert.deepEqual(st, { since: null, slow: false });
});

test('pure: fps from two frame counts, and null when no time has passed', () => {
  assert.equal(mod.fpsFromFrames(0, 0, 30, 1000), 30);
  assert.equal(mod.fpsFromFrames(0, 1000, 30, 1000), null);
});

test('pure: the warning line counts the slow sessions and is empty when none are', () => {
  assert.equal(mod.slowWarning(0), '');
  assert.equal(mod.slowWarning(2), 'Running slow: 2 games');
});

test('the warning appears when a session reports under 50 fps for 5 s', async () => {
  const realNow = Date.now;
  let t = 1000000;
  Date.now = () => t;
  try {
    mod.default.register(fakeCtx());
    const a = (await mod.startSession(T.a)).id;
    const frame = sess(a).iframe;
    mod.handleFrameMessage({ source: frame.contentWindow, data: { t: 'fps', fps: 30 } });
    mod.slowCheck(t);
    assert.doesNotMatch(textOf(mod.GamePage({})), /Running slow/);
    t += 5000;
    mod.slowCheck(t);
    assert.match(textOf(mod.GamePage({})), /Running slow: 1 games/);
  } finally {
    Date.now = realNow;
  }
});

test('with no fps report, the frame counter from status drives the warning', async () => {
  const realNow = Date.now;
  const base = 1000000;
  let t = base;
  Date.now = () => t;
  try {
    mod.default.register(fakeCtx());
    const a = (await mod.startSession(T.a)).id;
    const frame = sess(a).iframe;
    mod.handleFrameMessage({ source: frame.contentWindow, data: { t: 'ready' } });
    for (let k = 0; k <= 6; k++) {
      t = base + k * 1000;
      const p = mod.pollStatus();
      const sent = frame.contentWindow.posted.filter(m => m.op === 'status').at(-1);
      mod.handleFrameMessage({ source: frame.contentWindow, data: { id: sent.id, ok: true, frame: 30 * k } });
      await p;
      mod.slowCheck(t);
      if (k === 5) assert.doesNotMatch(textOf(mod.GamePage({})), /Running slow/, 'not flagged at 4 s under 50 fps');
    }
    assert.match(textOf(mod.GamePage({})), /Running slow: 1 games/);
  } finally {
    Date.now = realNow;
  }
});

test('the side panel has no chat: no input, no draft, no sendChat', () => {
  assert.doesNotMatch(SRC, /ChatSection|sendChat|Message the agent/);
});

test('an op naming a session goes to that session only', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  await mod.runCommand({ id: 'op-stop-a', op: 'stop', session: a });
  assert.equal(sess(a), undefined, 'A stopped');
  assert.equal(sess(b).iframe.isConnected, true, 'B untouched');
  assert.equal(replyFor(ctx, 'op-stop-a').ok, true);
});

test('the sessions op lists every session with its title and which one is active', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  mod.selectSession(a);
  await mod.runCommand({ id: 'op-list', op: 'sessions' });
  assert.deepEqual(replyFor(ctx, 'op-list').sessions, [
    { id: a, titleId: T.a.id, name: T.a.name, active: true },
    { id: b, titleId: T.b.id, name: T.b.name, active: false },
  ]);
});

test('an op naming an unknown session replies no such session', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  await mod.runCommand({ id: 'op-unknown', op: 'stop', session: 's999' });
  const body = replyFor(ctx, 'op-unknown');
  assert.equal(body.ok, false);
  assert.equal(body.error, 'no such session');
});

test('pad input goes only to the active session', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  mod.handleFrameMessage({ source: sess(a).iframe.contentWindow, data: { t: 'ready' } });
  mod.handleFrameMessage({ source: sess(b).iframe.contentWindow, data: { t: 'ready' } });
  mod.selectSession(a);
  mod.pollPads();
  const padsTo = id => sess(id).iframe.contentWindow.posted.filter(m => m.t === 'host-pad').length;
  assert.equal(padsTo(a), 1, 'active session gets the pad');
  assert.equal(padsTo(b), 0, 'other session gets no pad');
});

test('the side panel is registered once and survives until the last session stops', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  assert.equal(ctx.regs.filter(r => r.area === 'panes').length, 1, 'one panel registration');
  mod.stopSession(a);
  assert.equal(ctx.disposed.includes('panel'), false, 'panel stays while B runs');
  mod.stopSession(b);
  assert.equal(ctx.disposed.includes('panel'), true, 'panel disposed with the last session');
  const feeds = ctx.intervals.filter(i => i.ms !== 2000); // the 2 s agent poll is registration-lifetime
  assert.ok(feeds.length > 0 && feeds.every(i => i.stopped), 'feed timers stop with it');
});

test('unmounting the page keeps the same iframe and the panel registered', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  await mod.enterGamePage();
  const big = slotAt(0, 0, 600, 400);
  mod.attachSlot('big', big);
  const a = (await mod.startSession(T.a)).id;
  const frame = sess(a).iframe;
  mod.leaveGamePage();
  mod.detachSlot('big', big);
  assert.equal(sess(a).iframe, frame, 'same iframe');
  assert.equal(frame.isConnected, true, 'still in the document');
  assert.equal(document.state.removed, 0, 'nothing removed');
  assert.equal(ctx.disposed.includes('panel'), false, 'panel still registered');
});

test('re-mounting the page reuses the same iframe', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  await mod.enterGamePage();
  const big = slotAt(0, 0, 600, 400);
  mod.attachSlot('big', big);
  const a = (await mod.startSession(T.a)).id;
  const frame = sess(a).iframe;
  const created = document.state.created;
  mod.leaveGamePage();
  mod.detachSlot('big', big);
  await mod.enterGamePage();
  mod.attachSlot('big', slotAt(0, 0, 700, 500));
  assert.equal(sess(a).iframe, frame, 'same iframe after re-mount');
  assert.equal(document.state.created, created, 'no new iframe');
});

test('with no slot the iframe parks fixed bottom-right at 240x160', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  const frame = sess(a).iframe;
  assert.equal(frame.style.position, 'fixed');
  assert.equal(frame.style.width, '240px');
  assert.equal(frame.style.height, '160px');
  assert.equal(frame.style.right, '0px');
  assert.equal(frame.style.bottom, '0px');
});

test('stopping the last session removes its iframe and disposes the panel', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const a = (await mod.startSession(T.a)).id;
  const frame = sess(a).iframe;
  mod.stopSession(a);
  assert.equal(frame.isConnected, false, 'iframe removed');
  assert.equal(iframesOnBody().length, 0);
  assert.equal(ctx.disposed.includes('panel'), true);
});

test('two launches of the same title give two sessions with distinct ids and no shared agent-session field', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.a)).id;
  assert.notEqual(a, b, 'distinct session ids');
  assert.equal(sess(a).titleId, T.a.id);
  assert.equal(sess(b).titleId, T.a.id);
  assert.equal(Object.hasOwn(sess(a), 'agentSessionKey'), true, 'each session carries the field');
  assert.equal(sess(a).agentSessionKey, null, 'null until the Phase 0 creation mechanism exists');
  assert.equal(sess(b).agentSessionKey, null);
  assert.notEqual(sess(a), sess(b), 'two records, not one shared record');
});

// ---------- campaign goals (CONTRACTS §12.1): launch shows the stored goals; every change is written at once ----------

test('launch shows the goals the campaign store holds, before any agent message arrives', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const stored = { long: 'Beat the Elite Four', short: [{ id: 'g1', text: 'Get the Boulder Badge', done: true, progress: 1 }] };
  await mod.saveCampaignGoals(mod.campaignKeyFor(T.a), stored);
  const a = (await mod.startSession(T.a)).id;
  assert.deepEqual(sess(a).model.goals, stored);
  const panelText = textOf(ctx.regs.find(r => r.id === 'panel').render());
  assert.match(panelText, /Beat the Elite Four/);
  assert.match(panelText, /Get the Boulder Badge/);
});

test('stop a game with goals, launch it again: the new session (new id) shows the same goals with no agent message', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  const first = (await mod.startSession(T.a)).id;
  mod.toggleShortGoal(first, 's1');
  const before = sess(first).model.goals;
  mod.stopSession(first);
  const second = (await mod.startSession(T.a)).id;
  assert.notEqual(second, first, 'a new session id');
  assert.deepEqual(sess(second).model.goals, before, 'the goals the stopped session left');
  assert.equal(before.short.find(g => g.id === 's1').done, true);
  assert.match(textOf(ctx.regs.find(r => r.id === 'panel').render()), /Get the first badge/);
  assert.equal(ctx.rests.filter(r => r.path.startsWith('/reply')).length, 0, 'no agent reply involved');
});

test('a goal change is written to the campaign store at once, while the game still runs', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  mod.toggleShortGoal(a, 's2');
  assert.equal(sess(a).titleId, T.a.id, 'the session is still running');
  const stored = await mod.loadCampaignGoals(mod.campaignKeyFor(T.a));
  assert.equal(stored.short.find(g => g.id === 's2').done, true, 'stored before any Stop');
});

test('the agent open op with a titleId starts that title and navigates to /game', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  sdk.calls.length = 0;
  await mod.runCommand({ id: 'op-open-t', op: 'open', titleId: T.b.id });
  assert.deepEqual(mod.gameState().sessions.map(s => s.titleId), [T.b.id]);
  assert.deepEqual(navigates(), [{ op: 'navigate', path: '/game' }]);
  assert.equal(replyFor(ctx, 'op-open-t').session, mod.gameState().sessions[0].id);
});

test('the agent open op without a titleId navigates to /game home only', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  sdk.calls.length = 0;
  await mod.runCommand({ id: 'op-open-h', op: 'open' });
  assert.deepEqual(navigates(), [{ op: 'navigate', path: '/game' }]);
  assert.equal(mod.gameState().sessions.length, 0, 'no game started');
  assert.equal(mod.gameState().view.kind, 'home');
});

test('the agent open op with an unknown titleId replies no such title and starts nothing', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  await mod.runCommand({ id: 'op-open-x', op: 'open', titleId: 'ffffffffffffffff' });
  assert.equal(replyFor(ctx, 'op-open-x').ok, false);
  assert.equal(replyFor(ctx, 'op-open-x').error, 'no such title');
  assert.equal(mod.gameState().sessions.length, 0);
});

test('the rail marks the active session on /game as (on screen) instead of a second slot', async () => {
  const ctx = fakeCtx();
  mod.default.register(ctx);
  await mod.enterGamePage();
  mod.attachSlot('big', slotAt(0, 0, 600, 400));
  await mod.startSession(T.a);
  const panel = ctx.regs.find(r => r.id === 'panel');
  assert.match(textOf(panel.render()), /\(on screen\)/);
});

test('no code path references the removed /rom/list route, the game picker or pickGame', () => {
  assert.doesNotMatch(SRC, /\/rom\/list/);
  assert.doesNotMatch(SRC, /pickGame|GamePicker|pickGameName|gameNames/);
});

test('the game no longer uses SandboxedFrame; it is a raw iframe owned by the plugin', () => {
  assert.doesNotMatch(SRC, /SandboxedFrame/);
});

test('the activity section is labelled (demo) while demo timers feed it', () => {
  assert.match(SRC, /Agent activity \(demo\)/);
});

// ---------- §11: core files, load payload, mute ----------

beforeEach(() => {
  installDom();
  fetchLog.length = 0;
  sdk.calls.length = 0;
  mod.resetGameModeForTests();
});

test('coreFilesFor: paths match the manifest runtime.files (core/...) and the binding at the adapter root', () => {
  assert.deepEqual(mod.coreFilesFor('mgba'), { core: 'core/mgba.mjs', wasm: 'core/mgba.wasm', binding: 'binding.mjs' });
  assert.deepEqual(mod.coreFilesFor('quicknes'), { core: 'core/core.mjs', wasm: 'core/core.wasm', binding: 'binding.mjs' });
  assert.deepEqual(mod.coreFilesFor('dwarf-fortress'), { core: 'core/core.mjs', wasm: 'core/core.wasm', binding: 'binding.mjs' });
});

test('the adapter list and each core file are fetched once, in §11.2 order, before each ROM', async () => {
  mod.default.register(fakeCtx());
  await mod.startSession(T.a);
  await mod.startSession(T.b);
  const seen = fetchLog.map(f => f.path).filter(p => p === '/adapters' || p.startsWith('/core/') || p.startsWith('/rom/'));
  assert.deepEqual(seen, ['/adapters', '/core/mgba/core/mgba.mjs', '/core/mgba/core/mgba.wasm', '/core/mgba/binding.mjs',
    `/rom/${T.a.id}`, `/rom/${T.b.id}`]);
});

test('the load op carries the adapter entry, core text, wasm bytes, binding text and the ROM once the frame is ready', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  assert.equal(sess(a).iframe.contentWindow.posted.filter(m => m.op === 'load').length, 0, 'nothing before ready');
  mod.handleFrameMessage({ source: sess(a).iframe.contentWindow, data: { t: 'ready' } });
  const load = sess(a).iframe.contentWindow.posted.find(m => m.op === 'load');
  assert.ok(load, 'a load op was posted after ready');
  assert.equal(load.adapter.id, 'mgba');
  assert.deepEqual(load.adapter.buttons, ADAPTERS[0].buttons);
  assert.equal(load.coreSrc, '// core/mgba.mjs for mgba');
  assert.equal(load.bindingSrc, '// binding.mjs for mgba');
  assert.equal(load.wasm.byteLength, 2);
  assert.equal(load.rom.byteLength, 3);
});

test('switching the active session mutes every other session and unmutes the active one', async () => {
  mod.default.register(fakeCtx());
  const a = (await mod.startSession(T.a)).id;
  const b = (await mod.startSession(T.b)).id;
  for (const id of [a, b]) mod.handleFrameMessage({ source: sess(id).iframe.contentWindow, data: { t: 'ready' } });
  const lastMute = id => sess(id).iframe.contentWindow.posted.filter(m => m.op === 'mute').at(-1);
  assert.equal(lastMute(a).muted, true, 'A muted while B is active');
  assert.equal(lastMute(b).muted, false, 'B unmuted while active');
  mod.selectSession(a);
  assert.equal(lastMute(a).muted, false, 'A unmuted when selected');
  assert.equal(lastMute(b).muted, true, 'B muted when A is selected');
});

// ---------- static checks: the loader allows only these imports ----------

const SRC = readFileSync(PLUGIN, 'utf8');
const ALLOWED = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime']);

test('plugin.js imports only the allowed specifiers', () => {
  const specs = [...SRC.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(specs.length > 0, 'expected the SDK and React imports');
  for (const s of specs) assert.ok(ALLOWED.has(s), `disallowed import ${s}`);
});

test('every name plugin.js imports from the SDK is exported by the installed sdk source', t => {
  const sdkIndex = process.env.HERMES_SDK_INDEX
    || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'apps', 'desktop', 'src', 'sdk', 'index.ts');
  if (!existsSync(sdkIndex)) {
    t.skip(`installed SDK source not found at ${sdkIndex}; set HERMES_SDK_INDEX to check names`);
    return;
  }
  // index.ts re-exports ./areas wholesale (`export * from './areas'`), so both files count.
  const sources = [readFileSync(sdkIndex, 'utf8'),
    readFileSync(path.join(path.dirname(sdkIndex), 'areas.ts'), 'utf8')].join('\n');
  const names = [...SRC.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]@hermes\/plugin-sdk['"]/gm)]
    .flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
  assert.ok(names.length > 0);
  for (const n of names) {
    const exported = new RegExp(`export\\s+(const|function|class)\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`);
    assert.match(sources, exported, `${n} is not exported by the installed SDK`);
  }
});

// ---------- element helper ----------

test('h gives a void element no children prop (React #137: <input> must not have children)', () => {
  const el = mod.h('input', { type: 'checkbox', readOnly: true });
  assert.equal(el.type, 'input');
  assert.equal(Object.hasOwn(el.props, 'children'), false);
});

test('h passes a single child as-is and several as an array', () => {
  assert.equal(mod.h('b', {}, 'x').props.children, 'x');
  assert.deepEqual(mod.h('b', null, 'x', 'y').props.children, ['x', 'y']);
});

// Live bug: the page stayed on "loading the game…" because nothing re-rendered it after the game loaded
// (bump() called a rerender hook only the old tile installed).
test('GamePage re-renders when the plugin state changes (bump notifies its subscription)', async () => {
  const react = await import(pathToFileURL(path.join(here, 'stubs', 'react.mjs')).href);
  react.subscriptions.length = 0;
  mod.GamePage({});
  assert.ok(react.subscriptions.length >= 1, 'GamePage subscribes to the plugin store');
  let fired = 0;
  const unsubs = react.subscriptions.map(s => s(() => { fired++; }));
  mod.bump();
  unsubs.forEach(u => u && u());
  assert.ok(fired >= 1, 'bump() notifies the page');
});
