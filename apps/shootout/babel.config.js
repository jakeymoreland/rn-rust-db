// WatermelonDB models use decorators, so the shootout app needs the legacy
// decorator transform. This is one reason the shootout is a separate app:
// apps/sandbox produces the engine's published numbers and should not inherit
// a competitor's build requirements.
//
// The plugin must match Babel core's major version. @babel/plugin-proposal-
// decorators@8 against @babel/core@7 installs cleanly and then fails at runtime
// with "Decorating class property failed. Please ensure that
// transform-class-properties is enabled and runs after the decorators
// transform" — which points at plugin ordering and is misleading. It is a
// version mismatch.
//
// Do NOT add @babel/plugin-transform-class-properties here to chase that
// message: plugins run before presets, so it would transform class fields
// before babel-preset-expo's TypeScript pass, and every `declare` field in
// node_modules fails to parse. The preset already orders these correctly.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['@babel/plugin-proposal-decorators', { legacy: true }]],
  };
};
