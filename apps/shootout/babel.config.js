// No decorator plugin needed: the WatermelonDB contender uses raw accessors
// rather than @field/@text decorators. See src/contenders/watermelon.ts for
// why — three separate Babel failures, and the decorators buy nothing a
// benchmark cares about.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
