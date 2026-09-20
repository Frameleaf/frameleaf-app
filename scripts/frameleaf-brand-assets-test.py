#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("frameleaf-brand-assets.py")
spec = importlib.util.spec_from_file_location("brand_assets", SCRIPT)
brand_assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand_assets)
ROOT = SCRIPT.resolve().parents[1]


class BrandAssetContractTests(unittest.TestCase):
    def copy_repository(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        paths = {
            brand_assets.MANIFEST_PATH,
            brand_assets.INVENTORY_PATH,
            brand_assets.GUIDE_PATH,
            brand_assets.BACKLOG_PATH,
            brand_assets.JIRA_MAP_PATH,
            brand_assets.SOURCE_MANIFEST_PATH,
            *(Path(path) for path, _ in brand_assets.REFERENCE_SPECS),
            *(Path(path) for path, _, _ in brand_assets.COMPATIBILITY_SENTINELS),
        }
        manifest = brand_assets.load_json(ROOT / brand_assets.MANIFEST_PATH)
        paths.update(brand_assets.MANIFEST_PATH.parent / entry["path"] for entry in manifest["files"])
        for relative in paths:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
        return temporary, root

    def assert_invalid(self, mutation):
        temporary, root = self.copy_repository()
        with temporary:
            mutation(root)
            with self.assertRaises((KeyError, OSError, ValueError, json.JSONDecodeError)):
                brand_assets.validate(root)

    def test_repository_contract_passes(self):
        inventory = brand_assets.validate(ROOT)
        self.assertEqual(inventory["counts"]["suppliedVectors"], 7)
        self.assertFalse(inventory["qualification"]["nativeIntegrated"])
        self.assertEqual(inventory["sourceManifest"]["sha256"], brand_assets.SOURCE_MANIFEST_SHA256)
        rendered = json.dumps(brand_assets.build_inventory(ROOT), sort_keys=True)
        self.assertEqual(rendered, json.dumps(brand_assets.build_inventory(ROOT), sort_keys=True))
        self.assertNotIn(str(ROOT), rendered)

    def test_missing_stale_and_unknown_sources_are_rejected(self):
        mutations = (
            lambda root: (root / "design/frameleaf/brand-kit/frameleaf-symbol.svg").unlink(),
            lambda root: (root / "design/frameleaf/brand-kit/frameleaf-symbol.svg").write_text("stale"),
            lambda root: (root / "design/frameleaf/brand-kit/duplicate.svg").write_text("<svg/>")
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.assert_invalid(mutation)

    def test_nested_hidden_release_and_symlink_members_are_rejected(self):
        def nested(root):
            path = root / "design/frameleaf/brand-kit/.hidden/release.json"
            path.parent.mkdir()
            path.write_text("{}")

        def symlink(root):
            path = root / "design/frameleaf/brand-kit/release.json"
            path.symlink_to("README.txt")

        self.assert_invalid(nested)
        self.assert_invalid(symlink)

    def test_duplicate_manifest_identity_and_json_key_are_rejected(self):
        def duplicate_path(root):
            path = root / brand_assets.MANIFEST_PATH
            value = json.loads(path.read_text())
            value["files"][1]["path"] = value["files"][0]["path"]
            path.write_text(json.dumps(value))

        def duplicate_key(root):
            path = root / brand_assets.MANIFEST_PATH
            path.write_text(path.read_text().replace("{", '{"schemaVersion":99,', 1))

        self.assert_invalid(duplicate_path)
        self.assert_invalid(duplicate_key)

    def test_duplicate_svg_fragment_identity_is_rejected(self):
        temporary, root = self.copy_repository()
        with temporary:
            path = root / "design/frameleaf/brand-kit/frameleaf-symbol.svg"
            path.write_text(path.read_text().replace("</svg>", '<g id="title"/></svg>'))
            with self.assertRaises(ValueError):
                brand_assets.svg_facts(path)

    def test_svg_root_namespace_and_css_references_fail_closed(self):
        cases = (
            '<html xmlns="http://www.w3.org/1999/xhtml"/>',
            '<svg xmlns="http://www.w3.org/2000/svg"><html xmlns="http://www.w3.org/1999/xhtml"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:bad" x:flag="yes"/>',
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:unused="urn:bad"/>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.test/x.css";</style></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{fill:url(https://example.test/x.svg#a)}</style></svg>',
            '<?xml version="1.0"?><?xml-stylesheet type="text/css" href="https://example.test/evil.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
        )
        for source in cases:
            with self.subTest(source=source):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "test.svg"
                    path.write_text(source)
                    with self.assertRaises(ValueError):
                        brand_assets.svg_facts(path)

    def test_external_xml_processing_instruction_fails_closed(self):
        valid = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><title>Valid</title></svg>'
        malicious = valid.replace(
            "<svg",
            '<?xml-stylesheet type="text/css" href="https://example.test/evil.css"?><svg',
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.svg"
            path.write_text(valid)
            self.assertEqual(brand_assets.svg_facts(path)["title"], "Valid")
            path.write_text(malicious)
            with self.assertRaisesRegex(ValueError, "processing instructions"):
                brand_assets.svg_facts(path)

    def test_false_implementation_and_qualification_are_rejected(self):
        for field in ("webIntegrated", "nativeIntegrated", "productionQualified", "releaseQualified"):
            def mutation(root, field=field):
                path = root / brand_assets.INVENTORY_PATH
                value = json.loads(path.read_text())
                value["qualification"][field] = True
                path.write_text(json.dumps(value))
            with self.subTest(field=field):
                self.assert_invalid(mutation)

    def test_global_rebrand_compatibility_sentinel_is_rejected(self):
        def mutation(root):
            path = root / "mobile/pubspec.yaml"
            path.write_text(path.read_text().replace("immich_mobile", "frameleaf_mobile"))
        self.assert_invalid(mutation)

    def test_commented_and_disabled_compatibility_decoys_are_rejected(self):
        def yaml_decoy(root):
            path = root / "mobile/pubspec.yaml"
            path.write_text(path.read_text().replace("name: immich_mobile", "# name: immich_mobile\nname: frameleaf_mobile"))

        def yaml_asset_decoy(root):
            path = root / "mobile/pubspec.yaml"
            path.write_text(path.read_text().replace("image_path_android: 'assets/immich-logo.png'", "# image_path_android: 'assets/immich-logo.png'\n  image_path_android: 'assets/frameleaf-logo.png'"))

        def json_decoy(root):
            path = root / "packages/sdk/package.json"
            value = json.loads(path.read_text())
            value["name"] = "@frameleaf/sdk"
            value["compatibilityComment"] = '"name": "@immich/sdk"'
            path.write_text(json.dumps(value))

        def toml_decoy(root):
            path = root / "machine-learning/pyproject.toml"
            path.write_text(path.read_text().replace('name = "immich-ml"', '# name = "immich-ml"\nname = "frameleaf-ml"', 1))

        def svelte_decoy(root):
            path = root / "web/src/routes/+layout.svelte"
            path.write_text(path.read_text().replace("from '@immich/sdk'", "from '@frameleaf/sdk'\n  // import x from '@immich/sdk'"))

        for mutation in (yaml_decoy, yaml_asset_decoy, json_decoy, toml_decoy, svelte_decoy):
            with self.subTest(mutation=mutation):
                self.assert_invalid(mutation)

    def test_backlog_status_and_jira_identity_are_enforced(self):
        def qualified_owner(root):
            path = root / brand_assets.BACKLOG_PATH
            value = json.loads(path.read_text())
            next(item for item in value["items"] if item["id"] == "REL-103")["status"] = "done"
            path.write_text(json.dumps(value))

        def wrong_jira(root):
            path = root / brand_assets.JIRA_MAP_PATH
            value = json.loads(path.read_text())
            value["issues"]["REL-103"]["key"] = "FL-25"
            path.write_text(json.dumps(value))

        def wrong_owner_path(root):
            path = root / brand_assets.BACKLOG_PATH
            value = json.loads(path.read_text())
            next(item for item in value["items"] if item["id"] == "REL-103")["paths"].pop()
            path.write_text(json.dumps(value))

        def wrong_jira_id_and_url(root):
            path = root / brand_assets.JIRA_MAP_PATH
            value = json.loads(path.read_text())
            value["issues"]["REL-103"].update({"id": "99999", "url": "https://heroit.atlassian.net/browse/FL-999"})
            path.write_text(json.dumps(value))

        def wrong_owner_type(root):
            path = root / brand_assets.BACKLOG_PATH
            value = json.loads(path.read_text())
            next(item for item in value["items"] if item["id"] == "REL-103")["type"] = "task"
            path.write_text(json.dumps(value))

        self.assert_invalid(qualified_owner)
        self.assert_invalid(wrong_jira)
        self.assert_invalid(wrong_owner_path)
        self.assert_invalid(wrong_jira_id_and_url)
        self.assert_invalid(wrong_owner_type)

    def test_authority_manifests_and_false_claim_additions_are_rejected(self):
        def coherent_manifest_mutation(root):
            manifest_path = root / brand_assets.MANIFEST_PATH
            source_path = root / brand_assets.SOURCE_MANIFEST_PATH
            manifest = json.loads(manifest_path.read_text())
            manifest["files"][0]["bytes"] += 1
            manifest_path.write_text(json.dumps(manifest))
            source = json.loads(source_path.read_text())
            next(item for item in source["files"] if item["path"] == "brand-kit/README.txt")["bytes"] += 1
            source_path.write_text(json.dumps(source))

        def false_claim(root):
            path = root / brand_assets.INVENTORY_PATH
            value = json.loads(path.read_text())
            value["releaseEvidence"] = {"published": True}
            path.write_text(json.dumps(value))

        self.assert_invalid(coherent_manifest_mutation)
        self.assert_invalid(false_claim)


if __name__ == "__main__":
    unittest.main()
