import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

function absoluteBase(value, fallback) {
  const candidate = String(value || '').trim();
  return candidate && isAbsolute(candidate) ? candidate : fallback;
}

function absolutePath(value, baseDirectory) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  return resolve(isAbsolute(candidate) ? candidate : join(baseDirectory, candidate));
}

export function resolveRuntimePaths(root, environment = process.env, overrides = {}) {
  const projectRoot = resolve(root);
  const home = absoluteBase(environment.HOME, homedir());
  const configHome = absoluteBase(environment.XDG_CONFIG_HOME, join(home, '.config'));
  const cacheHome = absoluteBase(environment.XDG_CACHE_HOME, join(home, '.cache'));
  const stateHome = absoluteBase(environment.XDG_STATE_HOME, join(home, '.local', 'state'));
  const configDirectory = absolutePath(
    overrides.configDirectory || environment.VL3D_CONFIG_DIR || join(configHome, 'vl3d'),
    projectRoot,
  );
  const cacheDirectory = absolutePath(
    overrides.cacheDirectory || environment.VL3D_CACHE_DIR || join(cacheHome, 'vl3d'),
    projectRoot,
  );
  const stateDirectory = absolutePath(
    overrides.stateDirectory || environment.VL3D_STATE_DIR || join(stateHome, 'vl3d'),
    projectRoot,
  );
  return {
    projectRoot,
    configDirectory,
    cacheDirectory,
    stateDirectory,
    configFile: absolutePath(
      overrides.configFile || environment.VL3D_CONFIG || join(configDirectory, 'config.json'),
      projectRoot,
    ),
    projectConfigFile: join(projectRoot, 'vl3d.config.json'),
    dataRoot: absolutePath(
      overrides.dataRoot || environment.VL3D_DATA_DIR || join(cacheDirectory, 'data'),
      projectRoot,
    ),
  };
}

export function ensurePrivateDirectory(path) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${path} must be a real directory`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
  return realpathSync(path);
}

export function findExecutable(name, environment = process.env) {
  const candidate = String(name || '').trim();
  if (!candidate || /\0|[\r\n]/.test(candidate)) return null;
  const explicitPath = isAbsolute(candidate) || candidate.includes('/');
  const paths = explicitPath
    ? [resolve(candidate)]
    : String(environment.PATH || '/usr/local/bin:/usr/bin:/bin')
      .split(delimiter)
      .filter((entry) => entry && isAbsolute(entry))
      .map((entry) => resolve(entry, candidate));
  for (const entryPath of paths) {
    try {
      const targetPath = realpathSync(entryPath);
      if (!statSync(targetPath).isFile()) continue;
      accessSync(targetPath, constants.X_OK);
      return entryPath;
    } catch {
    }
  }
  return null;
}
