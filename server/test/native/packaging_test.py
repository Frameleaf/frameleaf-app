"""Bounded packaging gates; no compiler, packages, models or inference downloads."""
import json
import pathlib
import unittest
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[3]

class PackagingContract(unittest.TestCase):
    def test_both_server_images_install_the_patched_engine(self):
        for name in ('Dockerfile', 'Dockerfile.dev'):
            text = (ROOT/'server'/name).read_text()
            self.assertIn('AS base-server-darktable', text)
            self.assertIn('patch-darktable-lens.py', text)
            self.assertIn('patch-darktable-mask-geometry.py', text)
            self.assertIn('COPY --from=base-server-darktable /usr/local/share/', text)
            self.assertIn('verify-darktable.mjs', text)
    def test_native_pins_cover_required_submodules_and_lens_database(self):
        pins = json.loads((ROOT/'server/base-image/sources/darktable.json').read_text())
        self.assertEqual(pins['revision'], '03179f8e080aa9cedebfe14b098b7ba88940a292')
        self.assertEqual({x['name'] for x in pins['inputs']}, {'darktable', 'rawspeed', 'whereami', 'opencl', 'lensfun'})
        self.assertTrue(all(len(x['sha256']) == 64 and len(x['revision']) == 40 for x in pins['inputs']))
    def test_cpu_dependencies_and_wheels_have_a_frozen_selection(self):
        project = tomllib.loads((ROOT/'machine-learning/pyproject.toml').read_text())
        deps = project['project']['optional-dependencies']['cpu']
        self.assertIn('torch==2.5.1', deps)
        self.assertIn('torchvision==0.20.1', deps)
        self.assertIn('transformers==5.16.1', deps)
        lock = tomllib.loads((ROOT/'machine-learning/uv.lock').read_text())
        torch = [p for p in lock['package'] if p['name']=='torch' and p['version']=='2.5.1+cpu']
        self.assertEqual(len(torch), 1)
        self.assertTrue(any('cp312' in x['url'] and 'linux_x86_64' in x['url'] for x in torch[0]['wheels']))
    def test_cpu_image_import_gate_and_explicit_model_provisioning(self):
        text = (ROOT/'machine-learning/Dockerfile').read_text()
        self.assertIn('scripts/verify-semantic-runtime.py', text)
        self.assertIn('scripts/provision-semantic-models.py', text)
        self.assertIn('python:3.12-slim-trixie', text.split('AS builder-cpu')[0])

if __name__ == '__main__': unittest.main()
