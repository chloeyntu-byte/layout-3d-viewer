from __future__ import absolute_import

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

from .compiler import COMPILER_VERSION
from .errors import Vl3dError, error_from_payload


CACHE_ABI = 1


def _private_directory(path, create=False):
    path = os.path.abspath(os.path.expanduser(path))
    if os.path.lexists(path):
        if os.path.islink(path) or not os.path.isdir(path):
            raise Vl3dError('E4005', 'Native cache path is not a safe directory: %s' % path)
    elif create:
        try:
            os.makedirs(path, 0o700)
        except OSError:
            if not os.path.isdir(path) or os.path.islink(path):
                raise
    else:
        return False
    os.chmod(path, 0o700)
    return True


def default_cache_root(environment=None):
    environment = environment or os.environ
    base = environment.get('XDG_CACHE_HOME') or os.path.join(
        environment.get('HOME') or os.path.expanduser('~'), '.cache')
    return os.path.join(base, 'vl3d', 'native', 'v1')


def source_digest(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def cache_fingerprint(path, profile_hash='', compiler_version=COMPILER_VERSION):
    real_path = os.path.realpath(path)
    metadata = os.stat(real_path)
    payload = {
        'cacheAbi': CACHE_ABI,
        'compilerVersion': compiler_version,
        'profileHash': str(profile_hash or ''),
        'schema': 'layout-json-v2',
        'sha256': source_digest(real_path),
        'size': metadata.st_size,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


class CompiledLayout(object):
    def __init__(self, path, metadata, arrays):
        self.path = path
        self.metadata = metadata
        self.arrays = arrays


class CompileJob(object):
    def __init__(self, process, target, fingerprint):
        self.process = process
        self.target = target
        self.fingerprint = fingerprint

    def poll(self):
        return 0 if self.process is None else self.process.poll()

    def cleanup_temporary(self):
        if self.process is None:
            return
        process_id = int(getattr(self.process, 'pid', 0) or 0)
        if process_id <= 0 or len(self.fingerprint) != 64:
            return
        parent = os.path.dirname(self.target)
        prefix = '.compile-%s-%d-' % (self.fingerprint, process_id)
        try:
            names = os.listdir(parent)
        except OSError:
            return
        for name in names:
            if not name.startswith(prefix):
                continue
            path = os.path.join(parent, name)
            if os.path.islink(path) or not os.path.isdir(path):
                continue
            shutil.rmtree(path, ignore_errors=True)

    def cancel(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            try:
                self.process.terminate()
            except OSError:
                pass
            try:
                self.process.communicate(timeout=0.35)
            except subprocess.TimeoutExpired:
                try:
                    self.process.kill()
                except OSError:
                    pass
                self.process.communicate()
        self.cleanup_temporary()


class CacheManager(object):
    def __init__(self, root=None, maximum_mib=512, project_root=None):
        self.root = os.path.abspath(os.path.expanduser(root or default_cache_root()))
        _private_directory(self.root, create=True)
        self.maximum_bytes = int(maximum_mib) * 1024 * 1024
        self.project_root = os.path.realpath(project_root or os.path.join(
            os.path.dirname(__file__), os.pardir))

    def directory(self, fingerprint):
        return os.path.join(self.root, fingerprint)

    def complete(self, fingerprint):
        target = self.directory(fingerprint)
        if os.path.islink(target) or not os.path.isdir(target):
            return False
        marker = os.path.join(target, '.complete')
        if not os.path.isfile(marker) or not os.path.isfile(os.path.join(target, 'meta.json')):
            return False
        try:
            with open(marker, 'r') as handle:
                if handle.readline().strip() != fingerprint:
                    return False
            with open(os.path.join(target, 'meta.json'), 'r') as handle:
                metadata = json.load(handle)
            candidates = [marker, os.path.join(target, 'meta.json')]
            candidates.extend(os.path.join(target, name + '.npy') for name in metadata.get('arrays') or {})
            return all(os.path.isfile(path) and not os.path.islink(path) for path in candidates)
        except (IOError, ValueError, TypeError):
            return False

    def start_compile(self, source, profile_hash=''):
        _private_directory(self.root, create=True)
        fingerprint = cache_fingerprint(source, profile_hash)
        target = self.directory(fingerprint)
        if os.path.lexists(target):
            _private_directory(target)
        if self.complete(fingerprint):
            return CompileJob(None, target, fingerprint)
        environment = dict(os.environ)
        previous = environment.get('PYTHONPATH', '')
        environment['PYTHONPATH'] = self.project_root + (os.pathsep + previous if previous else '')
        command = [
            sys.executable, '-m', 'native.compiler_worker',
            '--source', os.path.realpath(source),
            '--target', target,
            '--fingerprint', fingerprint,
        ]
        process = subprocess.Popen(
            command,
            cwd=self.project_root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
        )
        return CompileJob(process, target, fingerprint)

    def finish_compile(self, job):
        if job.process is not None:
            stdout, stderr = job.process.communicate()
            job.cleanup_temporary()
            if job.process.returncode != 0:
                try:
                    payload = json.loads(stderr.decode('utf-8', 'replace').splitlines()[-1])
                except (ValueError, IndexError):
                    payload = {'message': stderr.decode('utf-8', 'replace') or 'Native compile failed'}
                raise error_from_payload(payload, 'E4002', 'Native compile failed')
        if not self.complete(job.fingerprint):
            raise Vl3dError('E4005', 'Native cache publish did not complete')
        return self.load(job.fingerprint)

    def load(self, fingerprint):
        try:
            import numpy
        except ImportError as error:
            raise Vl3dError('E1013', 'NumPy is required for the native cache: %s' % error)
        target = self.directory(fingerprint)
        _private_directory(target)
        if not self.complete(fingerprint):
            raise Vl3dError('E4005', 'Native cache is incomplete: %s' % fingerprint)
        os.chmod(os.path.join(target, 'meta.json'), 0o600)
        os.chmod(os.path.join(target, '.complete'), 0o600)
        with open(os.path.join(target, 'meta.json'), 'r') as handle:
            metadata = json.load(handle)
        arrays = {}
        for name in metadata.get('arrays') or {}:
            os.chmod(os.path.join(target, name + '.npy'), 0o600)
            arrays[name] = numpy.load(
                os.path.join(target, name + '.npy'), mmap_mode='r', allow_pickle=False)
        try:
            os.utime(os.path.join(target, '.complete'), None)
        except OSError:
            pass
        return CompiledLayout(target, metadata, arrays)

    def _directory_size(self, path):
        total = 0
        for root, directories, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
        return total

    def clean_lru(self, protected=None):
        protected = set(os.path.realpath(item) for item in (protected or []))
        _private_directory(self.root, create=True)
        records = []
        total = 0
        for name in os.listdir(self.root):
            path = os.path.join(self.root, name)
            if os.path.islink(path):
                raise Vl3dError('E4005', 'Native cache entry is an unsafe symlink: %s' % path)
            if not os.path.isdir(path) or name.startswith('.compile-'):
                continue
            _private_directory(path)
            size = self._directory_size(path)
            marker = os.path.join(path, '.complete')
            try:
                accessed = os.path.getmtime(marker)
            except OSError:
                accessed = 0
            records.append((accessed, path, size))
            total += size
        removed = []
        for accessed, path, size in sorted(records):
            if total <= self.maximum_bytes:
                break
            if os.path.realpath(path) in protected:
                continue
            shutil.rmtree(path, ignore_errors=True)
            total -= size
            removed.append(path)
        return removed
