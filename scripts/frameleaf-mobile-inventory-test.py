#!/usr/bin/env python3
import importlib.util
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('frameleaf-mobile-inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = inventory.snapshot()
        cls.serialized = json.dumps(cls.result, indent=2) + '\n'

    def validate_mutation(self, mutate_map=None, mutate_backlog=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            issue_map = json.loads(inventory.ISSUE_MAP.read_text())
            backlog = json.loads(inventory.BACKLOG.read_text())
            if mutate_map:
                mutate_map(issue_map)
            if mutate_backlog:
                mutate_backlog(backlog)
            issue_path = root / 'native-issue-map.json'
            backlog_path = root / 'backlog.json'
            issue_path.write_text(json.dumps(issue_map, indent=2) + '\n')
            backlog_path.write_text(json.dumps(backlog, indent=2) + '\n')
            with patch.object(inventory, 'ISSUE_MAP', issue_path), patch.object(inventory, 'BACKLOG', backlog_path):
                with self.assertRaises(ValueError):
                    inventory.validate_issue_map(self.result, self.serialized)

    def test_map_status_rationale_and_owners_fail_closed(self):
        mutations = [
            lambda value: value.update(status='qualified'),
            lambda value: value['entries'][0].update(status='qualified'),
            lambda value: value['entries'][0].update(rationale=''),
            lambda value: value['entries'][0]['secondaryIssueIds'].append(value['entries'][0]['primaryIssueId']),
            lambda value: value['entries'][0]['secondaryIssueIds'].append(value['entries'][0]['secondaryIssueIds'][0]),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.validate_mutation(mutate_map=mutate)

    def test_committed_row_schema_and_qualification_fail_closed(self):
        mutations = [
            lambda value: value.update(qualified=True),
            lambda value: value.pop('qualification'),
            lambda value: value.update(qualification='qualified'),
            lambda value: value.update(runtimeQualification='device-qualified'),
            lambda value: value.update(sourceAvailability='preserved-dirty-only'),
        ]
        for index, mutate in enumerate(mutations):
            entries = copy.deepcopy(self.result['entrypoints'])
            mutate(entries[0])
            with self.subTest(index=index), self.assertRaises(ValueError):
                inventory.validate_committed_entries(entries)

    def test_issue_map_cannot_contradict_committed_qualification(self):
        committed_id = self.result['entrypoints'][0]['id']
        self.validate_mutation(mutate_map=lambda value:
            next(row for row in value['entries'] if row['id'] == committed_id).update(qualification='qualified'))

    def test_unknown_release_claims_are_rejected_everywhere(self):
        self.validate_mutation(mutate_map=lambda value: value.update(releaseQualified=True))
        self.validate_mutation(mutate_map=lambda value: value['entries'][0].update(releaseQualified=True))
        manifest = json.loads(inventory.PRESERVED.read_text())
        for mutate in (lambda value: value.update(releaseQualified=True),
                lambda value: value['entries'][0].update(releaseQualified=True)):
            changed = copy.deepcopy(manifest)
            mutate(changed)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'preserved.json'
                path.write_text(json.dumps(changed))
                with patch.object(inventory, 'PRESERVED', path), self.assertRaises(ValueError):
                    inventory.preserved_requirements()

    def test_ambiguity_and_boundary_note_schemas_and_references_fail_closed(self):
        mutations = [
            lambda value: value['ambiguities'][0].update(unknown='field'),
            lambda value: value['ambiguities'][0].update(question={'releaseQualified': True}),
            lambda value: value['ambiguities'][0]['entryIds'].append('missing-entry'),
            lambda value: value['ambiguities'][0]['entryIds'].append(value['ambiguities'][0]['entryIds'][0]),
            lambda value: value['ambiguities'][0]['issueIds'].append('missing-issue'),
            lambda value: value['boundaryNotes'][0].update(unknown='field'),
            lambda value: value['boundaryNotes'][0].update(decision={'nested': {'releaseQualified': True}}),
            lambda value: value['boundaryNotes'][0]['entryIds'].append('missing-entry'),
            lambda value: value['boundaryNotes'][0]['issueIds'].append('missing-issue'),
            lambda value: value['boundaryNotes'][0].update(id=value['ambiguities'][0]['id']),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.validate_mutation(mutate_map=mutate)

    def test_ambiguity_links_are_bidirectionally_exact(self):
        ambiguity = json.loads(inventory.ISSUE_MAP.read_text())['ambiguities'][0]
        self.validate_mutation(mutate_map=lambda value:
            next(row for row in value['entries'] if row['id'] == ambiguity['entryIds'][0]).pop('ambiguityId'))
        self.validate_mutation(mutate_map=lambda value:
            value['entries'][0].update(ambiguityId=ambiguity['id']))

    def test_restored_native_backlog_guide_cannot_be_pending(self):
        owner_id = json.loads(inventory.ISSUE_MAP.read_text())['entries'][0]['primaryIssueId']
        self.validate_mutation(mutate_backlog=lambda backlog:
            next(item for item in backlog['items'] if item['id'] == owner_id).update(
                workstreamGuide='docs/docs/developer/frameleaf-plan/01-agent-execution.md',
                pendingWorkstreamGuide=inventory.NATIVE_GUIDE))

    def test_owner_backlog_status_and_type_fail_closed(self):
        owner_id = json.loads(inventory.ISSUE_MAP.read_text())['entries'][0]['primaryIssueId']
        for field, value in [('status', 'done'), ('type', 'epic')]:
            with self.subTest(field=field):
                self.validate_mutation(mutate_backlog=lambda backlog, field=field, value=value:
                    next(item for item in backlog['items'] if item['id'] == owner_id).update({field: value}))

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            issue_path = root / 'native-issue-map.json'
            issue_path.write_text(inventory.ISSUE_MAP.read_text().replace('{\n', '{\n  "status": "duplicate",\n', 1))
            with patch.object(inventory, 'ISSUE_MAP', issue_path):
                with self.assertRaises(ValueError):
                    inventory.validate_issue_map(self.result, self.serialized)

    def test_preserved_checkout_head_and_inventory_digest_are_required(self):
        manifest = json.loads(inventory.PRESERVED.read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'mobile').mkdir()
            (root / 'mobile/frameleaf-parity.json').write_text('{}\n')
            good_head = SimpleNamespace(stdout=manifest['preservedCheckoutHead'] + '\n')
            bad_head = SimpleNamespace(stdout='0' * 40 + '\n')
            with patch.object(inventory.subprocess, 'run', return_value=bad_head), self.assertRaises(ValueError):
                inventory.preserved_requirements(root)
            with patch.object(inventory.subprocess, 'run', return_value=good_head), self.assertRaises(ValueError):
                inventory.preserved_requirements(root)


if __name__ == '__main__':
    unittest.main()
