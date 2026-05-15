// Metro config — forces node-based file watching instead of watchman.
// Watchman cannot read files inside ~/Library/Mobile Documents (iCloud
// Drive) due to macOS sandboxing, so any project that lives in iCloud
// has to disable watchman or it will crash the bundler.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver = config.resolver || {};
config.watcher = {
  ...(config.watcher || {}),
  healthCheck: { enabled: false },
};
config.maxWorkers = 2;
// Tell metro-file-map to skip watchman entirely.
process.env.WATCHMAN_DISABLE = 'true';
config.fileMap = { ...(config.fileMap || {}), useWatchman: false };

module.exports = config;
