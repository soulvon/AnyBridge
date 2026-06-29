const os = require('os');
const path = require('path');

function configBaseDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'linux') {
    return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function configDir(appName = 'anybridge') {
  return process.env.BYOK_CONFIG_DIR || path.join(configBaseDir(), appName);
}

module.exports = {
  configBaseDir,
  configDir,
};
