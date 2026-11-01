import {platform} from '../../platform/index.js';

// Add a version only after the real event stream, final output and native
// authentication have been exercised. Desktop's CLI is independent of PATH.
export function supportedCodexVersion(value, platformName = platform.name) {
  const version = value.trim();
  return /^codex-cli 0\.163\.\d+$/.test(version) ||
    platformName === 'win32' && ['codex-cli 0.165.0-alpha.1.2', 'codex-cli 0.166.0-alpha.5.1'].includes(version);
}
