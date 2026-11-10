from __future__ import absolute_import

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

from native.cache import CacheManager, CompileJob, cache_fingerprint
from native.errors import Vl3dError


class StubbornProcess(object):
    def __init__(self, process_id=43210):
        self.pid = process_id
        self.terminated = False
        self.killed = False
        self.communicate_calls = 0

    def poll(self):
        return None

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def communicate(self, timeout=None):
        self.communicate_calls += 1
        if self.communicate_calls == 1:
            raise subprocess.TimeoutExpired(['native-worker'], timeout)
        return b'', b''


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='vl3d-native-cache-')
        self.source = os.path.join(self.directory, 'layout.json')
        with open(self.source, 'w') as handle:
            handle.write('{"schemaVersion":2,"cell":"A","shapes":[],"instances":[]}')

    def tearDown(self):
        shutil.rmtree(self.directory)

    def test_fingerprint_includes_content_and_profile(self):
        first = cache_fingerprint(self.source, 'profile-a')
        second = cache_fingerprint(self.source, 'profile-b')
        self.assertNotEqual(first, second)
        with open(self.source, 'a') as handle:
            handle.write('\n')
        third = cache_fingerprint(self.source, 'profile-a')
        self.assertNotEqual(first, third)

    def test_complete_marker_must_match_fingerprint(self):
        manager = CacheManager(root=os.path.join(self.directory, 'cache'), maximum_mib=64)
        fingerprint = 'a' * 64
        target = manager.directory(fingerprint)
        os.makedirs(target)
        with open(os.path.join(target, 'meta.json'), 'w') as handle:
            json.dump({'arrays': {}}, handle)
        with open(os.path.join(target, '.complete'), 'w') as handle:
            handle.write('b' * 64)
        self.assertFalse(manager.complete(fingerprint))
        with open(os.path.join(target, '.complete'), 'w') as handle:
            handle.write(fingerprint + '\n')
        self.assertTrue(manager.complete(fingerprint))

    def test_cached_compile_job_cancel_is_safe(self):
        job = CompileJob(None, '/tmp/cache', 'a' * 64)
        job.cancel()
        self.assertEqual(job.poll(), 0)

    def test_compile_job_cancel_kills_and_reaps_stubborn_worker(self):
        process = StubbornProcess()
        CompileJob(process, '/tmp/cache', 'a' * 64).cancel()
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertEqual(process.communicate_calls, 2)

    def test_compile_job_cancel_removes_only_its_worker_temporary_tree(self):
        cache = os.path.join(self.directory, 'cache')
        os.mkdir(cache)
        fingerprint = 'a' * 64
        own = os.path.join(cache, '.compile-%s-43210-owned' % fingerprint)
        other = os.path.join(cache, '.compile-%s-98765-other' % fingerprint)
        os.mkdir(own)
        os.mkdir(other)
        process = StubbornProcess(43210)
        CompileJob(process, os.path.join(cache, fingerprint), fingerprint).cancel()
        self.assertFalse(os.path.exists(own))
        self.assertTrue(os.path.isdir(other))

    def test_cache_root_is_private_and_symlink_is_rejected(self):
        root = os.path.join(self.directory, 'private-cache')
        os.mkdir(root, 0o755)
        CacheManager(root=root)
        self.assertEqual(stat.S_IMODE(os.stat(root).st_mode), 0o700)
        link = os.path.join(self.directory, 'cache-link')
        os.symlink(root, link)
        with self.assertRaises(Vl3dError) as context:
            CacheManager(root=link)
        self.assertEqual(context.exception.code, 'VL3D-E4005')


if __name__ == '__main__':
    unittest.main()
