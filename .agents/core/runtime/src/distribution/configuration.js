import { readUserData } from '../services/user-data.js';
import { releaseIndexName, legacyReleaseIndexName } from './products.js';
import { isRepository, isBranch } from './git-values.js';
import { readJSON } from './files.js';
import { fail } from './errors.js';

export function configuration(root, { user = false } = {}) {
  const config = readJSON(root, '.agents/core/distribution.json');
  if (![1, 2].includes(config.schema_version) || !isRepository(config.core_repository) ||
      (config.schema_version === 1 ? !isRepository(config.template_repository) : !isBranch(config.instance_branch)) ||
      !isBranch(config.core_branch) || typeof config.release_source !== 'string' || config.index_asset !== (config.schema_version === 1 ? legacyReleaseIndexName : releaseIndexName) ||
      !Number.isInteger(config.check_interval_seconds) || config.check_interval_seconds < 60 ||
      !Number.isInteger(config.request_timeout_seconds) || config.request_timeout_seconds < 1 || config.request_timeout_seconds > 60) {
    fail('DISTRIBUTION_CONFIG_INVALID', 'Invalid .agents/core/distribution.json.');
  }
  // Build/publish use only Core defaults; system operations explicitly opt in.
  if (!user) return config;
  const settings = readUserData({ root, namespace: 'settings' });
  return { ...config, ...(settings.values.updates ?? {}) };
}
