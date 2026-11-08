// Test stub for react: hook names only. Plugin code must not call hooks at module top level.
// useSyncExternalStore records each subscribe so tests can check a component re-renders on store changes.
export const subscriptions = [];
export const useState = v => [typeof v === 'function' ? v() : v, () => {}];
export const useEffect = () => {};
export const useRef = v => ({ current: v });
export const useCallback = fn => fn;
export const useMemo = fn => fn();
export const useSyncExternalStore = (subscribe, getSnapshot) => { subscriptions.push(subscribe); return getSnapshot(); };
