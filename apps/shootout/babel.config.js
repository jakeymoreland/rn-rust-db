// WatermelonDB models are defined with decorators, so the shootout app needs the
// legacy decorator transform. This is one of the reasons the shootout is a
// separate app: apps/sandbox produces the engine's published numbers and should
// not inherit a competitor's build requirements.
//
// Two things matter here and both bit on the first attempt:
//
//  - the plugin must match Babel core's major version. @babel/plugin-proposal-
//    decorators@8 against @babel/core@7 fails at runtime with "Decorating class
//    property failed", not at install time.
//  - decorators must be transformed BEFORE class properties, so class
//    properties is listed explicitly after it rather than left to the preset.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['@babel/plugin-proposal-decorators', { legacy: true }],
      ['@babel/plugin-transform-class-properties', { loose: true }],
    ],
  };
};
