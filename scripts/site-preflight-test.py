#!/usr/bin/env python3
"""Regression cases for defects observed in site maintenance."""
import contextlib
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('preflight', ROOT / 'scripts/site-preflight.py')
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)


class PreflightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='gitdocket-preflight-regression-')
        cls.root = pathlib.Path(cls.tmp.name)
        for path in ['site', 'docs', 'examples', 'scripts/extensions', 'release/public-export.json', 'README.md']:
            source, destination = ROOT / path, cls.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copyfile(source, destination)
        cls.version = json.loads((ROOT / 'site/docs/mcp/provenance.json').read_text())['executableVersion']

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @contextlib.contextmanager
    def changed(self, path, transform):
        target = self.root / path
        original = target.read_bytes()
        target.write_bytes(transform(original))
        try:
            yield
        finally:
            target.write_bytes(original)

    def errors(self):
        return pf.source_checks(self.root, self.version)[0]

    def test_maintained_source_passes(self):
        self.assertEqual(self.errors(), [])

    def test_stale_homepage_release_is_detected(self):
        with self.changed('site/index.html', lambda b: b.replace(self.version.encode(), b'0.0.1')):
            self.assertTrue(any('current release' in x for x in self.errors()))

    def test_invalid_documented_review_status_is_detected(self):
        with self.changed('site/docs/cli/index.html', lambda b: b.replace(b'in-review', b'review')):
            self.assertTrue(any('unsupported documented task status review' in x for x in self.errors()))

    def test_explicit_compatibility_minimum_remains_valid(self):
        self.assertEqual(pf.version_errors('GitDocket 0.6.0 or later; recommended current release ' + self.version, self.version), [])

    def test_schema_bytes_cannot_change_without_provenance(self):
        with self.changed('site/docs/mcp/tools.json', lambda b: b + b'\n'):
            self.assertTrue(any('MCP raw capture hash' in x for x in self.errors()))

    def test_stale_example_source_is_detected(self):
        with self.changed('examples/product-delivery/app/fixtures.js', lambda b: b + b'\n// changed\n'):
            self.assertTrue(any('stale generated example source' in x for x in self.errors()))

    def test_archive_corruption_is_detected(self):
        with self.changed('site/examples/workflow-examples.json', lambda b: json.dumps({**json.loads(b), 'sha256': '0' * 64}).encode()):
            self.assertTrue(any('archive hash differs' in x for x in self.errors()))

    def test_missing_fragment_is_detected(self):
        with self.changed('site/index.html', lambda b: b.replace(b'href="#main"', b'href="#absent"')):
            self.assertTrue(any('missing fragment' in x for x in self.errors()))

    def test_stale_asset_cache_hash_is_detected(self):
        with self.changed('site/styles.css', lambda b: b + b'\n/* changed */\n'):
            self.assertTrue(any('stale asset cache hash' in x for x in self.errors()))

    def test_http_200_fallback_is_not_a_valid_missing_page(self):
        path = self.root / 'site/404.html'
        self.assertFalse(pf.response_matches(200, 'text/html', path.read_bytes(), path, 404))

    def test_wrong_mime_and_wrong_download_bytes_fail(self):
        path = self.root / 'site/assets/social-preview.png'
        self.assertFalse(pf.response_matches(200, 'text/html', path.read_bytes(), path, 200))
        self.assertFalse(pf.response_matches(200, 'image/png', b'old-image', path, 200))

    def test_unverified_analytics_injection_is_not_normalized(self):
        body = b'<script src="https://static.cloudflareinsights.com/other.js" integrity="fake"></script>'
        with self.assertRaisesRegex(ValueError, 'unexpected analytics'):
            pf.normalize_html(body)

    def test_stale_browser_receipt_is_rejected(self):
        inputs = {p.relative_to(self.root).as_posix(): pf.digest(p.read_bytes()) for p in (self.root / 'site').rglob('*.html')}
        for name in ['site/styles.css', 'site/copy-install.js', 'site/assets/social-preview.png']:
            inputs[name] = pf.digest((self.root / name).read_bytes())
        receipt = {'schema': 'gitdocket-site-browser/v1', 'sourceCommit': 'a' * 40, 'publicCommit': 'b' * 40, 'inputs': inputs, 'checks': [{'name': name, 'status': 'passed'} for name in ['responsive', 'keyboard', 'copy', 'console', 'social']]}
        path = self.root / 'browser.json'
        path.write_text(json.dumps(receipt))
        self.assertEqual(pf.browser_check(self.root, path)['status'], 'passed')
        with self.changed('site/styles.css', lambda b: b + b'\n/* new layout */\n'):
            with self.assertRaisesRegex(ValueError, 'stale'):
                pf.browser_check(self.root, path)


if __name__ == '__main__':
    unittest.main()
