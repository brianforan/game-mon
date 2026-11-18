// Reads a setting from the environment, falling back to the Windows *user*
// environment in the registry. That covers variables set with setx (or the
// README's Read-Host one-liner) after the parent program - a terminal, the
// Claude desktop app - was started, which would otherwise not see them.
import { execFileSync } from 'node:child_process';

export function envOrUser(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'mi'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
