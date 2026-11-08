// Test stub for @hermes/plugin-sdk. Same export names the real plugin imports; no behaviour beyond recording.
// `calls` records host.openWorkspace and host.navigate so tests can check their order.
export const calls = [];
const noop = () => {};
export const host = {
  state: {},
  openWorkspace: (id, options) => { calls.push({ op: 'openWorkspace', id, title: options && options.title }); return noop; },
  restartGateway: async () => {},
  profileRoutes: async () => [],
  navigate: path => { calls.push({ op: 'navigate', path }); },
  revealPane: id => { calls.push({ op: 'revealPane', id }); },
  notify: noop,
  request: async () => ({}),
};
export const PALETTE_AREA = 'palette';
export const PANES_AREA = 'panes';
export const ROUTES_AREA = 'routes';
export const SIDEBAR_NAV_AREA = 'sidebar.nav';
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' };
export const SandboxedFrame = () => null;
export const WorkspacePageHeaderControl = () => null;
export const Badge = () => null;
export const Button = () => null;
export const Select = () => null;
export const SelectContent = () => null;
export const SelectItem = () => null;
export const SelectTrigger = () => null;
export const SelectValue = () => null;
export const SegmentedControl = () => null;
export const StatusDot = () => null;
export const Input = () => null;
