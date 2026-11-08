// emulator-catalog desktop half: game mode. Disk plugin, plain ESM, no JSX.
// Only @hermes/plugin-sdk, react and react/jsx-runtime may be imported. Pure logic is exported by name
// so desktop/test can check it without a running Hermes.
import {
  Badge, Button, host, PALETTE_AREA, PANES_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SegmentedControl, StatusDot,
  WorkspacePageHeaderControl,
} from '@hermes/plugin-sdk';
import * as React from 'react';
import { jsx } from 'react/jsx-runtime';

export const HIGHLIGHT_MS = 1200;
export const ACTIVITY_CAP = 50;
export const DEFAULT_PROFILE = 'default';
export const DEFAULT_FILE_PORT = 47911;
export const PARK_SIZE = { width: 240, height: 160 };
export const THUMB_WIDTH = 120;
export const SLOW_FPS = 50;
export const SLOW_MS = 5000;
export const FPS_REPORT_FRESH_MS = 3000;

// Game files come from the localhost file server (CONTRACTS §7), not the profile-scoped REST.
export function gameServerUrl(path, port = DEFAULT_FILE_PORT) {
  return `http://127.0.0.1:${port}${path}`;
}

// One title's game bytes: /rom/<titleId> (CONTRACTS §7). The id is the 16-hex title id, one path segment.
export function romPath(titleId) {
  return `/rom/${encodeURIComponent(titleId)}`;
}

// True only for this plugin's file server; any other server on the port is not ours.
export function isGameServerHealth(body) {
  return Boolean(body) && body.plugin === 'emulator-catalog';
}

export function serverMissingMessage(port = DEFAULT_FILE_PORT) {
  return `Game file server not running on 127.0.0.1:${port}. Enable emulator-catalog in at least one profile and restart the gateway.`;
}

// Game Mode is a route page (Kanban model): every entry point navigates to /game, and the page renders itself.
export const GAME_ROUTE = '/game';

// Route a backend call to a profile: ctx.rest keeps a ?profile= that is already in the path.
export function profileUrl(path, profile) {
  if (!profile) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}profile=${encodeURIComponent(profile)}`;
}

// The stored driving profile if it still exists, else 'default'.
export function resolveDrivingProfile(stored, profiles) {
  return stored && profiles.includes(stored) ? stored : DEFAULT_PROFILE;
}

// Unique backend profile names from profileRoutes() results (route objects or plain strings).
export function profileNames(routes) {
  const names = routes.map(r => (typeof r === 'string' ? r : r.targetProfile || r.profile || r.name || ''));
  return [...new Set(names.filter(Boolean))];
}

export function backendErrorMessage(profile) {
  return `The ${profile} profile doesn't have the game plugin enabled. Enable 'emulator-catalog' in that profile, then Restart gateway.`;
}

// Reply to one /pending command that needs no session. Pure: the caller does the I/O.
export function commandReply(cmd, state) {
  if (cmd.op === 'open') return { ok: true, op: 'open' };
  if (cmd.op === 'status') return { ok: true, op: 'status', open: state.open, backend: state.backend, loaded: state.loaded };
  return { ok: false, op: cmd.op, code: 'unsupported_op', error: `op ${cmd.op} is not in game mode yet` };
}

// Show Restart gateway after a profile change (the new driving profile needs a new gateway) and when the
// driving profile has no plugin (restarting is the recovery the message asks for).
export function restartNeeded(state) {
  return Boolean(state.needsRestart) || state.backend.state === 'missing';
}

// In-memory placeholder model for the side panel. Each running session owns one. Nothing here is real agent state yet.
export function initModel() {
  return {
    control: { mode: 'advisory', style: 'Hint only; you press the buttons', who: 'you' },
    goals: {
      long: 'Become the Champion of the Indigo Plateau',
      short: [
        { id: 's1', text: 'Get the first badge (Brock)', done: false, progress: 0.6 },
        { id: 's2', text: 'Catch 3 new Pokémon', done: false, progress: 0.3 },
        { id: 's3', text: 'Heal at the Pokémon Center once', done: true, progress: 1 },
      ],
    },
    reflexes: [
      { id: 'r1', name: 'Low HP escape', trigger: 'HP below 20%', action: 'Use Potion', count: 0, lastFiredAt: 0, lastWhy: '', highlightUntil: 0 },
      { id: 'r2', name: 'Dialog skip', trigger: 'Text box waiting', action: 'Press A', count: 0, lastFiredAt: 0, lastWhy: '', highlightUntil: 0 },
      { id: 'r3', name: 'Stuck in a wall', trigger: 'Position unchanged 5 s', action: 'Walk back', count: 0, lastFiredAt: 0, lastWhy: '', highlightUntil: 0 },
      { id: 'r4', name: 'Save before boss', trigger: 'Entering gym', action: 'Save state', count: 0, lastFiredAt: 0, lastWhy: '', highlightUntil: 0 },
    ],
    plan: ['Walk north to Pewter City', 'Enter the Gym', 'Beat Brock', 'Heal and save'],
    activity: [],
  };
}

// Fire one reflex: count up, stamp when and why, and light the row until now + HIGHLIGHT_MS.
export function reflexFire(model, id, now, why) {
  return {
    ...model,
    reflexes: model.reflexes.map(r => (r.id === id
      ? { ...r, count: r.count + 1, lastFiredAt: now, lastWhy: why, highlightUntil: now + HIGHLIGHT_MS }
      : r)),
  };
}

// Clear highlights whose time has passed.
export function reflexTick(model, now) {
  return {
    ...model,
    reflexes: model.reflexes.map(r => (r.highlightUntil && now >= r.highlightUntil ? { ...r, highlightUntil: 0 } : r)),
  };
}

// Newest lines last, capped so the stream never grows without bound.
export function pushActivity(list, line) {
  return [...list, line].slice(-ACTIVITY_CAP);
}

// CONTRACTS §11.2: which files of an adapter's core are fetched from /core/<id>/. The paths are the manifest's
// runtime.files (under core/) and its binding at the adapter root, exactly as the file server serves them.
export function coreFilesFor(adapterId) {
  if (adapterId === 'mgba') return { core: 'core/mgba.mjs', wasm: 'core/mgba.wasm', binding: 'binding.mjs' };
  return { core: 'core/core.mjs', wasm: 'core/core.wasm', binding: 'binding.mjs' };
}

// The part of a /adapters entry that the load op carries (CONTRACTS §11.1). No file paths.
export function adapterForLoad(entry) {
  const out = { id: entry.id, buttons: entry.buttons, controls: entry.controls, capabilities: entry.capabilities, systems: entry.systems };
  if (entry.audioRate !== undefined) out.audioRate = entry.audioRate;
  return out;
}

// Audio belongs to the active session only (CONTRACTS §10.4): every other session is muted.
export function shouldMute(sessionId, activeId) {
  return sessionId !== activeId;
}

// Which slot a session's frame is drawn over. Big (on /game) and mini (active, off /game) are the active
// session's; every session also has its own rail thumbnail. null means no slot, so the frame parks.
export function slotKeyFor(sessionId, activeId, attached) {
  if (sessionId === activeId && attached.has('big')) return 'big';
  if (sessionId === activeId && attached.has('mini')) return 'mini';
  if (attached.has(`rail:${sessionId}`)) return `rail:${sessionId}`;
  return null;
}

// "Found but not supported" text from the /library unsupported map. Empty map gives ''.
export function unsupportedText(unsupported) {
  return Object.entries(unsupported || {}).map(([ext, n]) => `${ext} ×${n}`).join(', ');
}

// The concurrent-session cap is a setting (ctx.storage 'maxSessions'). Null, missing or below 1 means no limit.
export function sessionCap(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

// Slow-game state machine: a session under SLOW_FPS for SLOW_MS is slow; one sample at or above SLOW_FPS clears it.
// A null sample (no measurement yet) leaves the state alone.
export function nextSlowState(st, fps, now) {
  if (fps === null || fps === undefined) return st;
  if (fps >= SLOW_FPS) return { since: null, slow: false };
  const since = st.since === null ? now : st.since;
  return { since, slow: now - since >= SLOW_MS };
}

// Frames per second between two frame-counter samples. Null until there are two samples a positive time apart.
export function fpsFromFrames(prevFrame, prevAt, frame, at) {
  if (prevFrame === null || prevFrame === undefined || prevAt === null || prevAt === undefined) return null;
  if (at <= prevAt) return null;
  return ((frame - prevFrame) * 1000) / (at - prevAt);
}

// The header's soft warning. Empty when no session is slow.
export function slowWarning(count) {
  return count > 0 ? `Running slow: ${count} games` : '';
}

// "Found but not supported" and the other user-facing copy stay in one place.
export function capMessage(cap) {
  return `${cap} games running`;
}

// ----- campaign goals (CONTRACTS §12.1). In-memory stub until the campaign store lands; the seam is these three
// functions only. Keyed by campaign, never by agent session. Until campaigns exist, a title has one default campaign.
const campaignGoals = new Map();
export function campaignKeyFor(title) {
  return `${title.id}:main`;
}
const copyGoals = g => JSON.parse(JSON.stringify(g));
export async function loadCampaignGoals(campaignKey) {
  return campaignGoals.has(campaignKey) ? copyGoals(campaignGoals.get(campaignKey)) : copyGoals(initModel().goals);
}
export async function saveCampaignGoals(campaignKey, goals) {
  campaignGoals.set(campaignKey, copyGoals(goals));
}
// Flip one short-term goal and write the whole goal set to the campaign store at once.
export function toggleShortGoal(sessionId, goalId) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  const short = s.model.goals.short.map(g => (g.id === goalId ? { ...g, done: !g.done, progress: g.done ? g.progress : 1 } : g));
  s.model = { ...s.model, goals: { ...s.model.goals, short } };
  saveCampaignGoals(s.campaignKey, s.model.goals);
  bump();
  return true;
}

// No kids → no children prop: React rejects any children on void elements like <input> (#137), even [].
export const h = (type, props, ...kids) => jsx(type, kids.length ? { ...(props || {}), children: kids.length === 1 ? kids[0] : kids } : { ...(props || {}) });
function dataUrl(html) { return 'data:text/html;charset=utf-8,' + encodeURIComponent(html); }

// ---------- desktop wiring: several game sessions, one iframe each, the Game Mode route page, the side panel ----------

const ID = 'emulator-catalog';
const DEMO_WHY = ['HP dropped under 20%', 'a dialog box is waiting', 'position unchanged for 5 s', 'about to enter a gym'];
const DEMO_LINES = ['Reading the screen: a route north is open.', 'Plan step 2 looks reachable.', 'Holding B to cancel a menu.', 'Waiting for the battle to start.'];
const IDLE_MODEL = initModel(); // what the side panel shows when no session is active (never mutated)
const cardStyle = { width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'inherit', cursor: 'pointer' };

let CTX = null;
let storedDriving = null; // raw saved choice; resolved against the live profile list on use
let profiles = [DEFAULT_PROFILE];
let backend = { state: 'idle', message: '' }; // idle | ok | missing
let needsRestart = false;
let notice = ''; // one line of page feedback (a failed launch, a failed library read)
let pageMounted = false;
let pageTimer = null; // page lifetime: retries the library while /game is open
let sessionTimers = []; // game lifetime: pad poll, status poll, demo feeds, placement and slow checks
let panelDispose = null; // game lifetime: the PANES_AREA side panel
let playerPage = null; // data: URL of /player.html, fetched once per window
let adapters = null; // GET /adapters, fetched once per window
const coreCache = new Map(); // adapterId -> Promise<{coreSrc, wasm, bindingSrc}>, fetched once per adapter
let libraryState = null; // GET /library
const catalogs = new Map(); // systemId -> titles, from GET /library/<systemId>
let sessions = new Map(); // sessionId -> Session
let activeId = null;
let counter = 0;
let view = { kind: 'home' }; // home | catalog {systemId} | playing
const slots = new Map(); // key ('big' | 'mini' | 'rail:<id>') -> element
const slotRefFns = new Map(); // key -> stable ref callback, so React does not re-attach on every render
let ro = null; // ResizeObserver shared by every slot
const seen = new Set();
const seqState = { seq: 0 };
const store = { listeners: new Set() };
let version = 0;

// One place that decides which profile a backend call goes to (see profileUrl).
const driving = () => resolveDrivingProfile(storedDriving, profiles);
const api = (path, opts) => CTX.rest(profileUrl(path, driving()), opts);
// Page state lives in module variables; bump() tells every subscribed component.
export const bump = () => { version++; store.listeners.forEach(l => l()); };
const getVersion = () => version;
const log = (kind, data) => api('/event', { method: 'POST', body: { kind, data: data || {}, at: Date.now(), side: 'host' } }).catch(() => {});
const subscribe = l => { store.listeners.add(l); return () => store.listeners.delete(l); };
const capNow = () => sessionCap(CTX ? CTX.storage.get('maxSessions', null) : null);

// Game files come from the localhost file server, not the profile-scoped REST, so the driving profile
// does not matter. The host (this renderer) fetches; a game frame only receives bytes by postMessage.
async function gameGet(path) {
  const res = await fetch(gameServerUrl(path, DEFAULT_FILE_PORT));
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res;
}

async function checkBackend() {
  try {
    const body = await (await gameGet('/health')).json();
    if (!isGameServerHealth(body)) throw new Error('another server answered on the port');
    backend = { state: 'ok', message: '' };
  } catch (err) {
    backend = { state: 'missing', message: serverMissingMessage(DEFAULT_FILE_PORT) };
  }
  bump();
  return backend.state === 'ok';
}

// GET /library: the systems with their counts and the unsupported extensions. Nothing else is loaded here.
export async function loadLibrary() {
  if (!(await checkBackend())) { libraryState = null; return false; }
  try {
    libraryState = await (await gameGet('/library')).json();
    notice = '';
  } catch (err) {
    notice = 'Library failed: ' + String((err && err.message) || err);
  }
  bump();
  return true;
}

// GET /library/<systemId>, cached per system.
async function catalogFor(systemId) {
  if (!catalogs.has(systemId)) {
    const body = await (await gameGet(`/library/${encodeURIComponent(systemId)}`)).json();
    catalogs.set(systemId, body.titles || []);
  }
  return catalogs.get(systemId);
}

export async function openCatalog(systemId) {
  view = { kind: 'catalog', systemId };
  bump();
  try {
    await catalogFor(systemId);
  } catch (err) {
    notice = 'Catalog failed: ' + String((err && err.message) || err);
  }
  bump();
}

// The title with this id in any system the library lists, or null. Loads catalogs as needed.
async function findTitle(titleId) {
  if (!libraryState && !(await loadLibrary())) return null;
  for (const sys of (libraryState && libraryState.systems) || []) {
    if (!(sys.count > 0)) continue;
    const titles = await catalogFor(sys.id);
    const hit = titles.find(t => t.id === titleId);
    if (hit) return hit;
  }
  return null;
}

// /adapters, fetched once for the window.
function adaptersOnce() {
  if (!adapters) {
    adapters = gameGet('/adapters').then(r => r.json()).catch(err => { adapters = null; throw err; });
  }
  return adapters;
}

// The core's .mjs, .wasm and binding.mjs for one adapter, fetched once and shared by its sessions (§11.2).
function coreOnce(adapterId) {
  if (!coreCache.has(adapterId)) {
    const files = coreFilesFor(adapterId);
    const base = `/core/${encodeURIComponent(adapterId)}/`;
    const p = (async () => {
      const coreSrc = await gameGet(base + files.core).then(r => r.text());
      const wasm = await gameGet(base + files.wasm).then(r => r.arrayBuffer());
      const bindingSrc = await gameGet(base + files.binding).then(r => r.text());
      return { coreSrc, wasm, bindingSrc };
    })();
    coreCache.set(adapterId, p);
    p.catch(() => coreCache.delete(adapterId));
  }
  return coreCache.get(adapterId);
}

// The player page as a data: URL, fetched once for the window.
function playerDataUrl() {
  if (!playerPage) {
    playerPage = gameGet('/player.html').then(r => r.text()).then(dataUrl).catch(err => { playerPage = null; throw err; });
  }
  return playerPage;
}

// Host fetch order per session (CONTRACTS §11.2): /adapters (cached) → /core/<id>/... (cached per adapter) → /rom/<titleId>.
async function payloadFor(title) {
  const list = await adaptersOnce();
  const entry = (list || []).find(a => a.id === title.adapter);
  if (!entry) throw new Error(`no adapter ${title.adapter} is installed`);
  const files = await coreOnce(entry.id);
  const rom = await gameGet(romPath(title.id)).then(r => r.arrayBuffer());
  return { adapter: adapterForLoad(entry), coreSrc: files.coreSrc, bindingSrc: files.bindingSrc, wasm: files.wasm.slice(0), rom };
}

// ----- frames: one iframe per session, created once, never re-parented -----

const activeSession = () => (activeId && sessions.get(activeId)) || null;
const isOnScreen = () => pageMounted && view.kind === 'playing' && Boolean(activeSession());

function toFrame(s, msg, transfer) {
  const w = s.iframe && s.iframe.contentWindow;
  if (w && s.frameReady) w.postMessage(msg, '*', transfer || []);
}

function frameCall(s, msg, timeoutMs = 15000) {
  const id = 'h' + (++seqState.seq);
  return new Promise(resolve => {
    const timer = setTimeout(() => { if (s.waiting.delete(id)) resolve({ ok: false, error: 'frame timeout' }); }, timeoutMs);
    timer?.unref?.();
    s.waiting.set(id, r => { clearTimeout(timer); resolve(r); });
    toFrame(s, { ...msg, id });
  });
}

function makeFrame(s, src) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', `Game: ${s.name}`);
  frame.referrerPolicy = 'no-referrer';
  frame.src = src;
  document.body.appendChild(frame);
  return frame;
}

function parkAt(frame) {
  Object.assign(frame.style, { position: 'fixed', left: 'auto', top: 'auto', right: '0px', bottom: '0px', width: `${PARK_SIZE.width}px`, height: `${PARK_SIZE.height}px`, zIndex: '40' });
}

function placeOver(frame, r) {
  Object.assign(frame.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto', zIndex: '40' });
}

// Every frame follows its slot. Called on every slot change, window resize, ResizeObserver tick and the 250 ms tick.
function placeAll() {
  const attached = new Set(slots.keys());
  for (const s of sessions.values()) {
    if (!s.iframe) continue;
    const key = slotKeyFor(s.id, activeId, attached);
    const el = key ? slots.get(key) : null;
    if (el) placeOver(s.iframe, el.getBoundingClientRect());
    else parkAt(s.iframe);
  }
}

export function attachSlot(key, el) {
  slots.set(key, el);
  el.onclick = () => focusSlot(key);
  if (typeof ResizeObserver === 'function') {
    ro ??= new ResizeObserver(() => placeAll());
    ro.observe(el);
  }
  placeAll();
}

export function detachSlot(key, el) {
  if (el !== undefined && slots.get(key) !== el) return;
  const old = slots.get(key);
  slots.delete(key);
  if (old && ro) ro.unobserve(old);
  placeAll();
}

function slotRef(key) {
  if (!slotRefFns.has(key)) slotRefFns.set(key, el => (el ? attachSlot(key, el) : detachSlot(key)));
  return slotRefFns.get(key);
}

// Clicking a slot focuses that session's iframe.
function focusSlot(key) {
  const s = key.startsWith('rail:') ? sessions.get(key.slice(5)) : activeSession();
  if (s && s.iframe && s.iframe.focus) s.iframe.focus();
}

// ----- per-session messaging, load, mute, status and fps -----

function applyMuteTo(s) {
  toFrame(s, { op: 'mute', muted: shouldMute(s.id, activeId) });
}

function applyMutes() {
  for (const s of sessions.values()) applyMuteTo(s);
}

async function loadSession(s) {
  if (!s.payload || s.loaded || !s.frameReady) return;
  s.loaded = true;
  const p = s.payload;
  const res = await frameCall(s, { op: 'load', adapter: p.adapter, coreSrc: p.coreSrc, wasm: p.wasm, bindingSrc: p.bindingSrc, rom: p.rom }, 30000);
  log('load', { titleId: s.titleId, ok: res.ok, error: res.error || null });
  if (res.ok) noteFor(s, 'Game loaded: ' + s.name);
  else { s.loaded = false; noteFor(s, 'Game failed to load: ' + (res.error || 'unknown error')); }
}

// The frame posts {t:'ready'} once; the load and the mute state go out then. {t:'fps'} is a player report if it sends one.
export function handleFrameMessage(ev) {
  const s = [...sessions.values()].find(x => x.iframe && ev.source === x.iframe.contentWindow);
  if (!s) return;
  const m = ev.data || {};
  if (m.t === 'ready') {
    s.frameReady = true;
    loadSession(s);
    applyMuteTo(s);
  } else if (m.t === 'fps') {
    s.fps = Number(m.fps);
    s.fpsReportedAt = Date.now();
  } else if (m.t === 'evidence') {
    log('frame:' + m.kind, { titleId: s.titleId, ...(m.data || {}) });
  } else if (m.id && s.waiting.has(m.id)) {
    const done = s.waiting.get(m.id);
    s.waiting.delete(m.id);
    done(m);
  }
}

// Ask every ready frame for its frame counter (the fallback when the player sends no fps report).
export function pollStatus() {
  return Promise.all([...sessions.values()].filter(s => s.frameReady).map(async s => {
    const r = await frameCall(s, { op: 'status' }, 3000);
    if (!r.ok || typeof r.frame !== 'number') return;
    const now = Date.now();
    const reported = s.fpsReportedAt !== null && now - s.fpsReportedAt < FPS_REPORT_FRESH_MS;
    if (!reported) s.fps = fpsFromFrames(s.lastFrame, s.lastFrameAt, r.frame, now);
    s.lastFrame = r.frame;
    s.lastFrameAt = now;
  }));
}

// Update each session's slow state from its latest fps and return how many are slow.
export function slowCheck(now) {
  let changed = false;
  for (const s of sessions.values()) {
    const next = nextSlowState(s.slowState, s.fps, now);
    if (next.since !== s.slowState.since || next.slow !== s.slowState.slow) changed = true;
    s.slowState = next;
  }
  if (changed) bump();
  return slowCount();
}

const slowCount = () => [...sessions.values()].filter(s => s.slowState.slow).length;

// Gamepad poll: the active session only.
export function pollPads() {
  let pads = [];
  try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : []; } catch (err) { pads = []; }
  const s = activeSession();
  if (s) toFrame(s, { t: 'host-pad', pads: pads.map(p => ({ id: p.id, mapping: p.mapping, buttons: p.buttons.map(b => ({ pressed: b.pressed })), axes: Array.from(p.axes) })) });
}

// ----- sessions -----

function noteFor(s, line) {
  if (!sessions.has(s.id)) return;
  s.model = { ...s.model, activity: pushActivity(s.model.activity, line) };
  bump();
}

// The side panel's model is the active session's model.
const IDLE = IDLE_MODEL;
const getModel = () => (activeSession() ? activeSession().model : IDLE);
function setModel(fn) {
  const s = activeSession();
  if (s) s.model = fn(s.model);
  bump();
}

function startGameLifetime() {
  if (!panelDispose) ctxRegisterPanel();
  if (!sessionTimers.length) {
    sessionTimers = [
      CTX.setInterval(pollPads, 33),
      CTX.setInterval(() => { pollStatus(); }, 1000),
      CTX.setInterval(reflexDemo, 5000),
      CTX.setInterval(activityDemo, 3000),
      CTX.setInterval(() => { for (const s of sessions.values()) s.model = reflexTick(s.model, Date.now()); bump(); }, 300),
      CTX.setInterval(() => { placeAll(); slowCheck(Date.now()); }, 250),
    ];
  }
}

function stopGameLifetime() {
  sessionTimers.forEach(dispose => dispose());
  sessionTimers = [];
  if (panelDispose) { panelDispose(); panelDispose = null; }
}

function reflexDemo() {
  const s = activeSession();
  if (!s) return;
  const i = Math.floor(Math.random() * DEMO_WHY.length);
  const r = s.model.reflexes[i];
  s.model = reflexFire(s.model, r.id, Date.now(), DEMO_WHY[i]);
  noteFor(s, `Reflex "${r.name}" fired: ${DEMO_WHY[i]}`);
}

function activityDemo() {
  const s = activeSession();
  if (s) noteFor(s, DEMO_LINES[Math.floor(Date.now() / 3000) % DEMO_LINES.length]);
}

// Start a game in a new session tab and make it active. The load waits for the frame's ready.
// Every launch is a new session (CONTRACTS §12.1): agentSessionKey is set once here and never looked up by title.
export async function startSession(title) {
  const cap = capNow();
  if (cap !== null && sessions.size >= cap) return { ok: false, capped: true, error: capMessage(cap) };
  const campaignKey = campaignKeyFor(title);
  const goals = await loadCampaignGoals(campaignKey); // the goals the campaign's last session left (§12.1)
  const s = {
    id: 's' + (++counter), titleId: title.id, name: title.name, iframe: null, model: { ...initModel(), goals },
    campaignKey, waiting: new Map(), frameReady: false, payload: null, loaded: false, stopped: false,
    agentSessionKey: null, // the Phase 0 proof creates it; null until then
    fps: null, fpsReportedAt: null, lastFrame: null, lastFrameAt: null, slowState: { since: null, slow: false },
  };
  sessions.set(s.id, s);
  activeId = s.id;
  view = { kind: 'playing' };
  if (sessions.size === 1) startGameLifetime();
  bump();
  try {
    const src = await playerDataUrl();
    s.payload = await payloadFor(title);
    if (s.stopped) return { ok: false, error: 'stopped while loading' };
    s.iframe = makeFrame(s, src);
  } catch (err) {
    const msg = String((err && err.message) || err);
    notice = `${title.name} failed to load: ${msg}`;
    dropSession(s);
    return { ok: false, error: msg };
  }
  applyMutes();
  placeAll();
  bump();
  return { ok: true, id: s.id };
}

// Remove one session: its frame, its pending calls, and (if it was active) the newest remaining one becomes active.
function dropSession(s) {
  s.stopped = true;
  sessions.delete(s.id);
  for (const resolve of s.waiting.values()) resolve({ ok: false, error: 'stopped' });
  s.waiting.clear();
  if (s.iframe) { s.iframe.remove(); s.iframe = null; }
  s.agentSessionKey = null; // dropped on Stop (CONTRACTS §12.1)
  if (activeId === s.id) activeId = sessions.size ? [...sessions.keys()].at(-1) : null;
  if (!sessions.size) { view = { kind: 'home' }; stopGameLifetime(); }
  applyMutes();
  placeAll();
  bump();
}

export function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'no such session' };
  dropSession(s);
  return { ok: true };
}

export function selectSession(id) {
  if (!sessions.has(id)) return false;
  activeId = id;
  view = { kind: 'playing' };
  applyMutes();
  placeAll();
  bump();
  return true;
}

function sessionList() {
  return [...sessions.values()].map(s => ({ id: s.id, titleId: s.titleId, name: s.name, active: s.id === activeId }));
}

// Page lifetime: the library and the page's own retry. Frames and the side panel are not touched.
export async function enterGamePage() {
  pageMounted = true;
  if (!pageTimer) pageTimer = CTX.setInterval(() => { if (backend.state !== 'ok') loadLibrary(); }, 3000);
  bump();
  await refreshProfiles();
  await loadLibrary();
}

export function leaveGamePage() {
  pageMounted = false;
  if (pageTimer) { pageTimer(); pageTimer = null; }
  bump();
}

// ctx.onDispose: every frame goes, then the panel and the timers.
function shutdownGameMode() {
  for (const s of [...sessions.values()]) dropSession(s);
  if (pageTimer) { pageTimer(); pageTimer = null; }
}

// Test-only: back to a fresh module state. Timers and the panel are disposed; no frame is left.
export function resetGameModeForTests() {
  for (const s of sessions.values()) s.stopped = true;
  sessions = new Map();
  activeId = null;
  counter = 0;
  view = { kind: 'home' };
  slots.clear();
  catalogs.clear();
  coreCache.clear();
  adapters = null;
  playerPage = null;
  libraryState = null;
  pageMounted = false;
  if (pageTimer) pageTimer();
  pageTimer = null;
  sessionTimers.forEach(dispose => dispose());
  sessionTimers = [];
  if (panelDispose) panelDispose();
  panelDispose = null;
  notice = '';
  backend = { state: 'idle', message: '' };
  seen.clear();
  ro = null;
  campaignGoals.clear();
}

export function gameState() {
  return { sessions: [...sessions.values()], activeId, view, pageMounted, notice };
}

// Every way a game starts (catalog click, agent open with a titleId) goes through here.
async function launch(title) {
  const r = await startSession(title);
  if (!r.ok && r.capped) notice = r.error;
  bump();
  return r;
}

// ----- profile dropdown and gateway restart -----

async function refreshProfiles() {
  try {
    const names = profileNames(await host.profileRoutes());
    profiles = names.includes(DEFAULT_PROFILE) ? names : [DEFAULT_PROFILE, ...names];
  } catch (err) {
    profiles = [DEFAULT_PROFILE];
  }
  bump();
}

function pickProfile(name) {
  storedDriving = name;
  if (CTX) CTX.storage.set('driving', name);
  needsRestart = true;
  backend = { state: 'idle', message: '' };
  bump();
}

async function restartAndReconnect() {
  try { await host.restartGateway(); } catch (err) { notice = 'Restart failed: ' + String((err && err.message) || err); }
  needsRestart = false;
  backend = { state: 'idle', message: '' };
  bump();
  await loadLibrary();
}

function DrivingSelect() {
  return h(Select, { value: driving(), onValueChange: pickProfile },
    h(SelectTrigger, {}, h(SelectValue, {})),
    h(SelectContent, {}, profiles.map(p => jsx(SelectItem, { value: p, children: p }, p))));
}

// ----- the page header: one tab per session, a '+' tab, the slow warning, the profile dropdown and the status dot -----

function TabsBar() {
  const list = [...sessions.values()];
  const cap = capNow();
  const atCap = cap !== null && list.length >= cap;
  const tabs = list.map(s => jsx('div', {
    'data-tab': s.id,
    onClick: () => selectSession(s.id),
    style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 6, cursor: 'pointer', background: s.id === activeId ? 'rgba(99,179,237,0.25)' : 'transparent' },
    children: [
      h('span', {}, s.name),
      h(Button, { size: 'xs', 'aria-label': `Stop ${s.name}`, onClick: e => { if (e && e.stopPropagation) e.stopPropagation(); stopSession(s.id); } }, '×'),
    ],
  }, s.id));
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
    ...tabs,
    h(Button, { size: 'xs', 'data-new': true, disabled: atCap, onClick: () => { view = { kind: 'home' }; bump(); } },
      atCap ? capMessage(cap) : '+'));
}

// The Game page's header control (WorkspacePageHeaderControl projects it into the page header).
export function GameHeader() {
  const tone = backend.state === 'ok' ? 'good' : backend.state === 'missing' ? 'bad' : 'muted';
  const slow = slowWarning(slowCount());
  return h(WorkspacePageHeaderControl, { id: 'emulator-catalog:header' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h(TabsBar, {}),
      slow ? h('span', { style: { color: '#f5b841', fontSize: 12 } }, slow) : null,
      h(DrivingSelect, {}),
      h(StatusDot, { tone }),
      restartNeeded({ needsRestart, backend }) ? h(Button, { size: 'xs', onClick: restartAndReconnect }, 'Restart gateway') : null));
}

// ----- the page body: home, catalog, or the active session in the big slot -----

function HomeView() {
  const systems = ((libraryState && libraryState.systems) || []).filter(s => s.count > 0);
  const unsupported = unsupportedText(libraryState && libraryState.unsupported);
  return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' } },
    [...sessions.values()].map(s => jsx('button', {
      type: 'button', 'data-resume': s.id, onClick: () => selectSession(s.id), style: cardStyle,
      children: `Now playing: ${s.name} — Resume`,
    }, s.id)),
    systems.map(s => jsx('button', {
      type: 'button', 'data-system': s.id, onClick: () => openCatalog(s.id), style: cardStyle,
      children: `${s.name} · ${s.count} titles`,
    }, s.id)),
    unsupported ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, `Found but not supported: ${unsupported}`) : null,
    libraryState === null ? h('div', { style: { opacity: 0.7 } }, 'Loading the library…') : null);
}

function CatalogView({ systemId }) {
  const sys = ((libraryState && libraryState.systems) || []).find(s => s.id === systemId);
  const titles = catalogs.get(systemId);
  return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' } },
    h('div', {}, h(Button, { size: 'xs', onClick: () => { view = { kind: 'home' }; bump(); } }, 'Back')),
    h('div', { style: { fontWeight: 600 } }, sys ? sys.name : systemId),
    titles === undefined ? h('div', { style: { opacity: 0.7 } }, 'Loading titles…') : titles.map(t => jsx('button', {
      type: 'button', 'data-title': t.id, style: cardStyle,
      onClick: () => launch(t),
      children: `${t.name} · ${t.code} · pack ${t.pack ? 'yes' : 'no'}`,
    }, t.id)));
}

function MainArea() {
  if (view.kind === 'playing' && activeSession()) {
    return h('div', { style: { flex: 1, minHeight: 0, position: 'relative' } },
      h('div', { 'data-game-slot': 'big', ref: slotRef('big'), style: { position: 'absolute', inset: 0 } }));
  }
  if (view.kind === 'catalog') return h(CatalogView, { systemId: view.systemId });
  return h(HomeView, {});
}

// The Game page itself. It owns no frame: the frames belong to the sessions and outlive this page.
export function GamePage() {
  React.useEffect(() => { enterGamePage(); return leaveGamePage; }, []);
  React.useSyncExternalStore(subscribe, getVersion);
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0b0e' } },
    h(GameHeader, {}),
    backend.state === 'missing' ? h('div', { style: { padding: '8px 10px', color: '#f5b841' } }, backend.message) : null,
    notice ? h('div', { style: { padding: '4px 10px', color: '#f5b841', fontSize: 12 } }, notice) : null,
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, h(MainArea, {})));
}

// ----- the side panel: running games rail, then the active session's sections (no chat) -----

const headStyle = { width: '100%', textAlign: 'left', background: 'transparent', border: 0, color: 'inherit', padding: '8px 12px', cursor: 'pointer', fontWeight: 600 };

function Section({ title, children }) {
  const [open, setOpen] = React.useState(true);
  return h('section', { style: { borderBottom: '1px solid rgba(255,255,255,0.08)' } },
    h('button', { type: 'button', onClick: () => setOpen(o => !o), style: headStyle }, (open ? '▾ ' : '▸ ') + title),
    open ? h('div', { style: { padding: '4px 12px 10px' } }, children) : null);
}

// One row per running session. On /game the active one reads "(on screen)"; otherwise the active one holds the
// larger mini slot. Every other session holds its own thumbnail slot. Clicking a row makes that session active.
function RailSection() {
  const list = [...sessions.values()];
  const onScreen = isOnScreen();
  return h(Section, { title: 'Running games' },
    list.length === 0 ? h('div', { style: { opacity: 0.7 } }, 'No games running') : list.map(s => {
      const active = s.id === activeId;
      const here = active && onScreen;
      const key = active ? 'mini' : `rail:${s.id}`;
      return jsx('div', {
        'data-rail': s.id, onClick: () => selectSession(s.id), style: { marginBottom: 8, cursor: 'pointer' },
        children: [
          h('div', { style: { fontWeight: 600, fontSize: 12 } }, s.name),
          here
            ? h('div', { style: { opacity: 0.7, fontSize: 11 } }, '(on screen)')
            : h('div', { 'data-slot': key, ref: slotRef(key),
              style: { width: active ? '100%' : THUMB_WIDTH, aspectRatio: '16 / 10', background: '#000', borderRadius: 4 } }),
        ],
      }, s.id);
    }));
}

function ControlSection({ m }) {
  return h(Section, { title: 'Control' },
    h(SegmentedControl, {
      options: [{ id: 'advisory', label: 'Advisory' }, { id: 'assist', label: 'Assist' }, { id: 'full', label: 'Full control' }],
      value: m.control.mode,
      onChange: mode => setModel(s => ({ ...s, control: { ...s.control, mode } })),
    }),
    h('div', { style: { margin: '6px 0', opacity: 0.8 } }, m.control.style),
    h(Badge, { variant: m.control.who === 'you' ? 'default' : 'warn' }, m.control.who === 'you' ? 'You have control' : 'Agent has control'));
}

function GoalsSection({ m }) {
  return h(Section, { title: 'Goals' },
    h('div', { style: { fontWeight: 600, marginBottom: 6 } }, m.goals.long),
    m.goals.short.map(g => jsx('div', { style: { marginBottom: 6 }, children: [
      h('label', {}, h('input', { type: 'checkbox', checked: g.done, onChange: () => { if (activeId) toggleShortGoal(activeId, g.id); } }), ' ', g.text),
      h('div', { style: { height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2 } },
        h('div', { style: { width: `${Math.round(g.progress * 100)}%`, height: '100%', background: '#63b3ed', borderRadius: 2 } })),
    ] }, g.id)));
}

function ReflexSection({ m }) {
  const now = Date.now();
  return h(Section, { title: 'Reflexes (demo)' }, m.reflexes.map(r => {
    const lit = r.highlightUntil > now;
    return jsx('div', { style: { padding: '4px 6px', borderRadius: 4, marginBottom: 4, background: lit ? 'rgba(99,179,237,0.28)' : 'transparent', transition: 'background-color 1.2s' }, children: [
      h('div', { style: { fontWeight: 600 } }, `${r.name} · fired ${r.count}×`),
      h('div', { style: { opacity: 0.7, fontSize: 11 } }, `${r.trigger} → ${r.action}`),
      r.lastFiredAt ? h('div', { style: { fontSize: 11 } }, `last fired: ${r.lastWhy}`) : null,
    ] }, r.id);
  }));
}

function PlanSection({ m }) {
  return h(Section, { title: 'Plan' }, h('ol', { style: { margin: 0, paddingLeft: 18 } }, m.plan.map((step, i) => jsx('li', { children: step }, i))));
}

function ActivitySection({ m }) {
  // column-reverse keeps the newest line at the bottom without any scroll code. Fed by activityDemo until Phase 1/2.
  return h(Section, { title: 'Agent activity (demo)' },
    h('div', { style: { display: 'flex', flexDirection: 'column-reverse', maxHeight: 180, overflowY: 'auto', fontSize: 11 } },
      [...m.activity].reverse().map((line, i) => jsx('div', { style: { padding: '2px 0' }, children: line }, i))));
}

function SidePanel() {
  const m = React.useSyncExternalStore(subscribe, getModel);
  return h('div', { style: { height: '100%', overflowY: 'auto' } },
    h(RailSection, {}), h(ControlSection, { m }), h(GoalsSection, { m }), h(ReflexSection, { m }),
    h(PlanSection, { m }), h(ActivitySection, { m }));
}

// Registered when the first session starts, disposed when the last one stops (CONTRACTS §10.4).
function ctxRegisterPanel() {
  if (panelDispose) return;
  panelDispose = CTX.register({
    id: 'panel',
    area: PANES_AREA,
    title: 'Game',
    data: { placement: 'main', dock: { pane: 'workspace', pos: 'right', enforce: true }, width: '380px' },
    render: () => h(SidePanel, {}),
  });
}

// Every entry point (palette, status bar, agent 'open', sidebar row) navigates to /game and nowhere else.
export function openGame(hostApi = host) {
  hostApi.navigate(GAME_ROUTE);
}

// ----- agent commands (/pending) -----

async function opOpen(cmd) {
  openGame(host);
  if (!cmd.titleId) { view = { kind: 'home' }; bump(); return { ok: true, op: 'open' }; }
  const title = await findTitle(cmd.titleId);
  if (!title) return { ok: false, op: 'open', error: 'no such title' };
  const r = await launch(title);
  return r.ok ? { ok: true, op: 'open', session: r.id } : { ok: false, op: 'open', error: r.error };
}

function opStop(cmd) {
  const id = cmd.session !== undefined ? cmd.session : activeId;
  if (!sessions.has(id)) return { ok: false, op: 'stop', error: 'no such session' };
  stopSession(id);
  return { ok: true, op: 'stop', session: id };
}

// Each op takes an optional `session` (default: the active one). An unknown session is refused for every op
// except open and sessions, which name no session.
export async function runCommand(cmd) {
  if (!cmd || !cmd.id || seen.has(cmd.id)) return;
  seen.add(cmd.id);
  let res;
  if (cmd.session !== undefined && cmd.op !== 'open' && cmd.op !== 'sessions' && !sessions.has(cmd.session)) {
    res = { ok: false, op: cmd.op, error: 'no such session' };
  } else if (cmd.op === 'open') {
    res = await opOpen(cmd);
  } else if (cmd.op === 'stop') {
    res = opStop(cmd);
  } else if (cmd.op === 'sessions') {
    res = { ok: true, op: 'sessions', sessions: sessionList() };
  } else {
    res = commandReply(cmd, { open: pageMounted, backend: backend.state, loaded: sessions.size > 0 });
  }
  await api('/reply', { method: 'POST', body: { id: cmd.id, ...res } }).catch(() => {});
}

// Agent commands arrive via /pending (polled); runCommand answers them.
function pollPending() {
  if (!CTX || backend.state === 'missing') return;
  api('/pending').then(r => (r.cmds || []).forEach(runCommand)).catch(() => {});
}

export default {
  id: ID,
  name: 'Emulator catalog: game mode',
  description: 'Play your own local games on the Game page, several at once, with a side panel for goals, reflexes and agent activity.',
  register(ctx) {
    CTX = ctx;
    storedDriving = ctx.storage.get('driving', null);
    ctx.onDispose(shutdownGameMode);
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: GAME_ROUTE }, render: () => h(GamePage, {}) });
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, order: 60, data: { codicon: 'game', label: 'Game', path: GAME_ROUTE } });
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: { id: ID + '.game-mode', label: 'Game mode', keywords: ['game', 'emulator', 'pokemon', 'play'], run: () => openGame(host) },
    });
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 125,
      render: () => h('button', { type: 'button', title: 'Open game mode', onClick: () => openGame(host) }, '🎮 game'),
    });
    ctx.addEventListener(window, 'message', handleFrameMessage);
    ctx.addEventListener(window, 'resize', () => placeAll());
    ctx.setInterval(pollPending, 2000);
  },
};
