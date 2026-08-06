// WatermelonDB models are defined with decorators, so the shootout app needs
// the legacy decorator transform. This is one of the reasons the shootout is a
// separate app: apps/sandbox produces the engine's published numbers and should
// not inherit a competitor's build requirements.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['@babel/plugin-proposal-decorators', { legacy: true }]],
  };
};
