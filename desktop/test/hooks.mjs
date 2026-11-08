// Node resolve hook for tests only: maps the three specifiers the desktop loader allows onto stubs.
// The real loader injects the SDK and React; here they are no-op stand-ins with the same export names.
const STUBS = {
  '@hermes/plugin-sdk': 'sdk.mjs',
  react: 'react.mjs',
  'react/jsx-runtime': 'jsx-runtime.mjs',
};

export async function resolve(specifier, context, next) {
  if (Object.hasOwn(STUBS, specifier)) {
    return { url: new URL(`./stubs/${STUBS[specifier]}`, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
