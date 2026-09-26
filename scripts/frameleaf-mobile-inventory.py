#!/usr/bin/env python3
"""Refresh/check the source-based native parity inventory. Does not claim runtime qualification."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'mobile/frameleaf-parity.json'
PRESERVED = ROOT / 'mobile/frameleaf-preserved-dirty-evidence.json'
ISSUE_MAP = ROOT / 'docs/docs/developer/frameleaf-plan/native-issue-map.json'
BACKLOG = ROOT / 'docs/docs/developer/frameleaf-plan/backlog.json'
# Existing native counterparts are evidence of partial coverage, not full web parity.
COUNTERPARTS = {
 'photos': ['mobile/lib/presentation/pages/dev/main_timeline.page.dart'],
 'search': ['mobile/lib/presentation/pages/search/search.page.dart'],
 'albums': ['mobile/lib/presentation/pages/album.page.dart', 'mobile/lib/presentation/pages/remote_album.page.dart'],
 'people': ['mobile/lib/presentation/pages/people_collection.page.dart', 'mobile/lib/presentation/pages/person.page.dart'],
 'map': ['mobile/lib/presentation/pages/map.page.dart'],
 'places': ['mobile/lib/presentation/pages/place.page.dart'],
 'favorites': ['mobile/lib/presentation/pages/favorite.page.dart'],
 'archive': ['mobile/lib/presentation/pages/archive.page.dart'],
 'trash': ['mobile/lib/presentation/pages/trash.page.dart'],
 'locked': ['mobile/lib/presentation/pages/locked_folder.page.dart'],
 'partners': ['mobile/lib/pages/library/partner/partner.page.dart'],
 'sharing': ['mobile/lib/presentation/pages/album.page.dart'],
 'shared-links': ['mobile/lib/pages/library/shared_link/shared_link.page.dart'],
 'folders': ['mobile/lib/pages/library/folder/folder.page.dart'],
 'recently-added': ['mobile/lib/presentation/pages/recently_added.page.dart'],
 'memories': ['mobile/lib/presentation/pages/memory_list.page.dart'],
 'tags': ['mobile/lib/presentation/actions/tag.action.dart'],
 'user-settings': ['mobile/lib/pages/common/settings.page.dart'],
 'auth': ['mobile/lib/pages/login/login.page.dart', 'mobile/lib/pages/login/change_password.page.dart'],
 'studio': ['mobile/lib/frameleaf/studio.page.dart'],
}
GAPS = [
 ('unified-discovery', 'Shared structured queries, contextual facets, saved smart albums, timestamped moments and command palette'),
 ('guided-faces', 'Durable face verdicts, split review, correction history and undo'),
 ('shared-spaces', 'Space roles, recipient previews, people identity links and private naming'),
 ('takeout', 'Resumable Takeout staging, scan/review/import/reconciliation'),
 ('classification', 'Rule preview, provenance and rule-owned generated results'),
 ('culling', 'Synchronized near-duplicate/burst comparison, quality explanations and keeper decisions'),
 ('memory-stories', 'Editable event stories, preferences, timezone birthdays and independent highlight export'),
 ('pets', 'Named individual pets, manual observation correction and model proposals'),
 ('enrichment', 'Reusable video-frame workbench, preview and dependency stages including opt-in captions'),
 ('library-care', 'Combined health/repair/migration queues with evidence'),
 ('preservation', 'Verified originals/sidecars/recipes manifests and restoration reconciliation'),
 ('documents', 'OCR-grounded fields, cropped evidence and corrections'),
 ('photo-tools', 'Selective masks, presets and external RAW rendition workflows'),
 ('ai-video', 'Explicit local/Frameleaf Cloud destination, preview comparison, jobs and qualified restoration'),
 ('native-studio', 'Project/revision/source review exists in preview; the canonical command and payload contract is published for native clients (mobile/lib/frameleaf/studio_commands.g.dart), while native graph editing, effects/animation/audio and qualified render/export remain unavailable'),
 ('administration', 'All server settings, ML/GPU endpoints, queues, users, libraries, migration and fork handoff controls'),
]
COMMITTED_QUALIFICATION = 'inventory-only-not-qualified'
COMMITTED_SCHEMAS = {
 'native-route': {'id', 'kind', 'source', 'routeClass', 'implementation', 'frameleafRedesign',
                  'runtimeQualification', 'sourceAvailability', 'qualification'},
 'native-asset-action': {'id', 'kind', 'source', 'implementation', 'frameleafRedesign',
                         'runtimeQualification', 'sourceAvailability', 'qualification'},
 'native-settings-component': {'id', 'kind', 'source', 'implementation', 'frameleafRedesign',
                               'runtimeQualification', 'sourceAvailability', 'qualification'},
 'web-page': {'id', 'kind', 'source', 'area', 'audience', 'nativeParity', 'nativeEvidence',
              'frameleafRedesign', 'runtimeQualification', 'sourceAvailability', 'qualification'},
 'web-admin-setting': {'id', 'kind', 'source', 'nativeParity', 'frameleafRedesign',
                       'runtimeQualification', 'sourceAvailability', 'qualification'},
}
PRESERVED_TOP_LEVEL = {'schemaVersion', 'scope', 'preservedCheckoutHead', 'reviewedCleanBaseline',
                       'dirtyInventorySha256', 'entries'}
ISSUE_MAP_TOP_LEVEL = {'schemaVersion', 'sourceInventory', 'sourceSha256', 'backlogPath', 'scope', 'status',
                       'mappingPolicy', 'counts', 'entries', 'ambiguities', 'boundaryNotes', 'preservedEvidence'}
OWNERSHIP_FIELDS = {'primaryIssueId', 'secondaryIssueIds', 'status', 'rationale'}
AMBIGUITY_FIELDS = {'id', 'entryIds', 'issueIds', 'status', 'question', 'blockingScope'}
BOUNDARY_NOTE_FIELDS = {'id', 'entryIds', 'issueIds', 'decision'}
NATIVE_GUIDE = 'docs/docs/developer/frameleaf-plan/04-native-and-release.md'
OPEN_OWNER_STATUSES = {'planned-not-qualified', 'delivered-with-open-qualification-gaps'}


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON key is prohibited: {key}')
        result[key] = value
    return result


def load_json(path):
    return json.loads(path.read_text(), object_pairs_hook=reject_duplicate_keys)


def json_scalar(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    raise TypeError(f'Unsupported JSON scalar: {type(value).__name__}')


def canonical_json(value):
    """Serialize the inventory like root Prettier plus recursive lexical JSON sorting."""
    def primitive_array(values):
        if not all(item is None or isinstance(item, (str, int, float, bool)) for item in values):
            return None
        return '[' + ', '.join(json_scalar(item) for item in values) + ']'

    def render(current, indent=0, column=0):
        if isinstance(current, dict):
            if not current:
                return '{}'
            keys = sorted(current)
            lines = ['{']
            for index, key in enumerate(keys):
                prefix = ' ' * (indent + 2) + json_scalar(key) + ': '
                child_lines = render(current[key], indent + 2, len(prefix)).splitlines()
                lines.append(prefix + child_lines[0])
                lines.extend(child_lines[1:])
                if index < len(keys) - 1:
                    lines[-1] += ','
            lines.append(' ' * indent + '}')
            return '\n'.join(lines)
        if isinstance(current, list):
            flat = primitive_array(current)
            if flat is not None and column + len(flat) <= 80:
                return flat
            if not current:
                return '[]'
            lines = ['[']
            for index, item in enumerate(current):
                child_lines = render(item, indent + 2, indent + 2).splitlines()
                lines.append(' ' * (indent + 2) + child_lines[0])
                lines.extend(child_lines[1:])
                if index < len(current) - 1:
                    lines[-1] += ','
            lines.append(' ' * indent + ']')
            return '\n'.join(lines)
        return json_scalar(current)

    return render(value) + '\n'


def reject_nested_release_claims(value, location='native issue map'):
    if isinstance(value, dict):
        if 'releaseQualified' in value:
            raise ValueError(f'{location}: releaseQualified claims are prohibited')
        for key, child in value.items():
            reject_nested_release_claims(child, f'{location}.{key}')
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_nested_release_claims(child, f'{location}[{index}]')


def validate_native_backlog_guides(items):
    for item in items:
        if item.get('workstream') != 'native':
            continue
        if item.get('workstreamGuide') != NATIVE_GUIDE:
            raise ValueError(f'{item.get("id")}: restored native row must use the native/release guide')
        if 'pendingWorkstreamGuide' in item or 'workstreamGuideStatus' in item:
            raise ValueError(f'{item.get("id")}: restored native guide cannot retain pending-guide markers')


def validate_note_references(records, exact_fields, record_kind, inventory, backlog_by_id):
    ids = [record.get('id') for record in records]
    if None in ids or len(ids) != len(set(ids)):
        raise ValueError(f'{record_kind} IDs must be present and unique')
    for record in records:
        if set(record) != exact_fields:
            raise ValueError(f'{record.get("id")}: {record_kind} does not match its exact schema')
        for field in exact_fields - {'entryIds', 'issueIds'}:
            if not isinstance(record.get(field), str) or not record[field].strip():
                raise ValueError(f'{record.get("id")}: {record_kind} {field} must be a nonempty string')
        entry_ids = record['entryIds']
        issue_ids = record['issueIds']
        if (not isinstance(entry_ids, list) or not entry_ids or len(entry_ids) != len(set(entry_ids))
                or any(entry_id not in inventory for entry_id in entry_ids)):
            raise ValueError(f'{record["id"]}: {record_kind} entry references must be unique known inventory IDs')
        if (not isinstance(issue_ids, list) or not issue_ids or len(issue_ids) != len(set(issue_ids))
                or any(issue_id not in backlog_by_id for issue_id in issue_ids)):
            raise ValueError(f'{record["id"]}: {record_kind} issue references must be unique known backlog IDs')
        for issue_id in issue_ids:
            owner = backlog_by_id[issue_id]
            if owner.get('type') != 'story' or owner.get('status') not in OPEN_OWNER_STATUSES:
                raise ValueError(f'{record["id"]}: {record_kind} owner {issue_id} must remain an open story')


def validate_committed_entries(entries):
    ids = [entry.get('id') for entry in entries]
    if len(ids) != len(set(ids)) or None in ids:
        raise ValueError('Committed inventory IDs must be present and unique')
    for entry in entries:
        kind = entry.get('kind')
        if kind not in COMMITTED_SCHEMAS or set(entry) != COMMITTED_SCHEMAS[kind]:
            raise ValueError(f'{entry.get("id")}: committed inventory row does not match the exact {kind} schema')
        if entry['sourceAvailability'] != 'committed-source' or entry['qualification'] != COMMITTED_QUALIFICATION:
            raise ValueError(f'{entry["id"]}: committed source inventory cannot imply release qualification')
        if entry['runtimeQualification'] != 'not-device-qualified':
            raise ValueError(f'{entry["id"]}: committed source inventory cannot imply device qualification')
        if not isinstance(entry['source'], str) or not (ROOT / entry['source']).is_file():
            raise ValueError(f'{entry["id"]}: committed source path is missing')
        if entry['id'].split('#', 1)[0] != entry['source']:
            raise ValueError(f'{entry["id"]}: committed inventory ID must identify its source')
        if kind.startswith('native-'):
            if entry['implementation'] not in ('existing-native', 'implemented-preview'):
                raise ValueError(f'{entry["id"]}: native implementation status is invalid')
            if entry['frameleafRedesign'] not in ('pending', 'review-only-preview'):
                raise ValueError(f'{entry["id"]}: native redesign status is invalid')
        elif kind == 'web-page':
            if entry['audience'] not in ('administrator', 'end-user') or entry['nativeParity'] not in (
                    'partial-existing-counterpart', 'not-implemented') or not isinstance(entry['nativeEvidence'], list):
                raise ValueError(f'{entry["id"]}: web-page planning fields are invalid')
        elif entry['nativeParity'] != 'not-implemented' or entry['frameleafRedesign'] != 'pending':
            raise ValueError(f'{entry["id"]}: administrator-setting planning fields are invalid')


def preserved_requirements(source_root=None):
    manifest = load_json(PRESERVED)
    if set(manifest) != PRESERVED_TOP_LEVEL:
        raise ValueError('Preserved dirty evidence has unknown or missing top-level fields')
    if manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('entries'), list):
        raise ValueError('Preserved dirty evidence must use schema version 1 and contain an entries array')
    for field in ('preservedCheckoutHead', 'reviewedCleanBaseline', 'dirtyInventorySha256'):
        if not re.fullmatch(r'[0-9a-f]{40}' if field != 'dirtyInventorySha256' else r'[0-9a-f]{64}',
                manifest.get(field, '')):
            raise ValueError(f'Preserved dirty evidence {field} is invalid')
    entries = manifest['entries']
    ids = [entry.get('id') for entry in entries]
    if len(entries) != 16 or len(set(ids)) != len(ids) or None in ids:
        raise ValueError('Preserved dirty evidence must contain the 16 unique reviewed source rows')
    if source_root is not None:
        head = subprocess.run(['git', '-C', str(source_root), 'rev-parse', 'HEAD'], check=True,
            capture_output=True, text=True).stdout.strip()
        if head != manifest.get('preservedCheckoutHead'):
            raise ValueError('Preserved checkout HEAD differs from the recorded evidence revision')
        dirty_inventory = source_root / 'mobile/frameleaf-parity.json'
        dirty_digest = hashlib.sha256(dirty_inventory.read_bytes()).hexdigest()
        if dirty_digest != manifest.get('dirtyInventorySha256'):
            raise ValueError('Preserved checkout inventory differs from the recorded dirty inventory digest')
    for entry in entries:
        kind = entry.get('kind')
        expected = COMMITTED_SCHEMAS.get(kind)
        if expected is None or set(entry) != expected | {'sourceSha256', 'sourceBytes'}:
            raise ValueError(f'{entry.get("id")}: preserved evidence row does not match its exact schema')
        source = entry.get('source')
        if not isinstance(source, str) or (ROOT / source).exists():
            raise ValueError(f'{entry.get("id")}: preserved evidence must remain absent from the committed baseline until reconciled')
        if entry.get('sourceAvailability') != 'preserved-dirty-only' or entry.get('qualification') != 'not-committed-not-qualified':
            raise ValueError(f'{entry["id"]}: preserved evidence cannot imply committed or qualified behavior')
        if not re.fullmatch(r'[0-9a-f]{64}', entry.get('sourceSha256', '')) or not isinstance(entry.get('sourceBytes'), int):
            raise ValueError(f'{entry["id"]}: preserved source hash and byte count are required')
        if source_root is not None:
            data = (source_root / source).read_bytes()
            if len(data) != entry['sourceBytes'] or hashlib.sha256(data).hexdigest() != entry['sourceSha256']:
                raise ValueError(f'{entry["id"]}: preserved checkout source no longer matches recorded evidence')
    return manifest


def validate_issue_map(result, serialized_inventory):
    issue_map = load_json(ISSUE_MAP)
    reject_nested_release_claims(issue_map)
    if set(issue_map) != ISSUE_MAP_TOP_LEVEL:
        raise ValueError('Native issue map has unknown or missing top-level fields')
    backlog_items = load_json(BACKLOG)['items']
    backlog_by_id = {item['id']: item for item in backlog_items}
    if len(backlog_by_id) != len(backlog_items):
        raise ValueError('Consolidated backlog IDs must be unique')
    validate_native_backlog_guides(backlog_items)
    committed = {entry['id']: entry for entry in result['entrypoints']}
    validate_committed_entries(result['entrypoints'])
    preserved = {entry['id']: entry for entry in result['preservedRequirements']}
    inventory = committed | preserved
    ambiguities = issue_map.get('ambiguities')
    boundary_notes = issue_map.get('boundaryNotes')
    if not isinstance(ambiguities, list) or not isinstance(boundary_notes, list):
        raise ValueError('Native issue-map ambiguities and boundaryNotes must be arrays')
    validate_note_references(ambiguities, AMBIGUITY_FIELDS, 'ambiguity', inventory, backlog_by_id)
    validate_note_references(boundary_notes, BOUNDARY_NOTE_FIELDS, 'boundary note', inventory, backlog_by_id)
    note_ids = [record['id'] for record in ambiguities + boundary_notes]
    if len(note_ids) != len(set(note_ids)):
        raise ValueError('Ambiguity and boundary-note IDs must be globally unique')
    ambiguity_by_entry = {}
    for ambiguity in ambiguities:
        if ambiguity['status'] != 'requires-owner-policy-before-enablement':
            raise ValueError(f'{ambiguity["id"]}: ambiguity status is invalid')
        for entry_id in ambiguity['entryIds']:
            if entry_id in ambiguity_by_entry:
                raise ValueError(f'{entry_id}: inventory entry cannot reference multiple ambiguities')
            ambiguity_by_entry[entry_id] = ambiguity['id']
    mapped = issue_map.get('entries', [])
    mapped_ids = [entry.get('id') for entry in mapped]
    if issue_map.get('schemaVersion') != 2:
        raise ValueError('Native issue map must use schema version 2')
    if issue_map.get('status') != 'planned-not-qualified':
        raise ValueError('Native issue map must remain planned-not-qualified')
    if set(mapped_ids) != set(inventory) or len(mapped_ids) != len(set(mapped_ids)):
        raise ValueError('Native issue map must cover every preservation row exactly once')
    if issue_map.get('sourceSha256') != hashlib.sha256(serialized_inventory.encode()).hexdigest():
        raise ValueError('Native issue map source hash does not match mobile/frameleaf-parity.json')
    by_kind = Counter(entry['kind'] for entry in mapped)
    by_primary = Counter(entry.get('primaryIssueId') for entry in mapped)
    expected_counts = {'entries': len(mapped), 'byKind': dict(by_kind), 'byPrimaryIssue': dict(by_primary),
        'committedEntries': len(committed), 'preservedDirtyRequirements': len(preserved),
        'totalPreservationRows': len(mapped)}
    if issue_map.get('counts') != expected_counts:
        raise ValueError('Native issue map counts do not match its entries')
    evidence = issue_map.get('preservedEvidence', {})
    if set(evidence) != {'path', 'preservedCheckoutHead', 'reviewedCleanBaseline', 'dirtyInventorySha256', 'qualification'}:
        raise ValueError('Native issue-map preserved evidence has unknown or missing fields')
    for key in ('preservedCheckoutHead', 'reviewedCleanBaseline', 'dirtyInventorySha256', 'qualification'):
        if evidence.get(key) != result['preservedEvidence'].get(key):
            raise ValueError(f'Native issue map preserved evidence differs for {key}')
    if evidence.get('path') != str(PRESERVED.relative_to(ROOT)):
        raise ValueError('Native issue map preserved evidence path is incorrect')
    for mapping in mapped:
        source = inventory[mapping['id']]
        expected = COMMITTED_SCHEMAS.get(mapping.get('kind'))
        allowed = expected | OWNERSHIP_FIELDS if expected else set()
        if mapping.get('ambiguityId') is not None:
            allowed |= {'ambiguityId'}
        if expected is None or set(mapping) != allowed:
            raise ValueError(f'{mapping.get("id")}: issue-map row does not match its exact schema')
        if mapping.get('ambiguityId') != ambiguity_by_entry.get(mapping['id']):
            raise ValueError(f'{mapping["id"]}: issue-map ambiguity reference is missing or inconsistent')
        for key, value in source.items():
            if key not in ('sourceSha256', 'sourceBytes') and mapping.get(key) != value:
                raise ValueError(f'{mapping["id"]}: issue-map source fields differ from the inventory')
        expected_availability = 'committed-source' if mapping['id'] in committed else 'preserved-dirty-only'
        if mapping.get('sourceAvailability') != expected_availability:
            raise ValueError(f'{mapping["id"]}: issue-map source availability is incorrect')
        if mapping.get('status') != 'planned-not-qualified':
            raise ValueError(f'{mapping["id"]}: issue-map row must remain planned-not-qualified')
        if not isinstance(mapping.get('rationale'), str) or not mapping['rationale'].strip():
            raise ValueError(f'{mapping["id"]}: issue-map rationale is required')
        secondary = mapping.get('secondaryIssueIds')
        if (not isinstance(secondary, list) or any(not isinstance(issue_id, str) for issue_id in secondary)
                or len(secondary) != len(set(secondary))):
            raise ValueError(f'{mapping["id"]}: secondary issue owners must be a unique list')
        issue_ids = [mapping.get('primaryIssueId'), *secondary]
        if None in issue_ids or len(issue_ids) != len(set(issue_ids)) or any(issue_id not in backlog_by_id for issue_id in issue_ids):
            raise ValueError(f'{mapping["id"]}: issue-map ownership references an unknown backlog item')
        for issue_id in issue_ids:
            owner = backlog_by_id[issue_id]
            if owner.get('type') != 'story' or owner.get('status') not in OPEN_OWNER_STATUSES:
                raise ValueError(f'{mapping["id"]}: owner {issue_id} must be an open or qualification-pending story')
        if mapping['id'] in preserved and mapping.get('qualification') != 'not-committed-not-qualified':
            raise ValueError(f'{mapping["id"]}: preserved issue-map row implies unavailable qualification')


def snapshot():
    entries = []
    for file in sorted((ROOT / 'mobile/lib').rglob('*.dart')):
        path = str(file.relative_to(ROOT))
        if file.name.endswith(('.g.dart', '.gr.dart', '.freezed.dart', '.drift.dart', '.steps.dart')):
            continue
        text = file.read_text()
        kind = None
        if '@RoutePage' in text:
            kind = 'native-route'
        elif '/presentation/actions/' in path and file.name.endswith('.action.dart'):
            kind = 'native-asset-action'
        elif '/widgets/settings/' in path:
            kind = 'native-settings-component'
        if kind:
            routes = re.findall(r'@RoutePage\([^)]*\)\s*class\s+(\w+)', text) if kind == 'native-route' else []
            for route in routes or [None]:
                entries.append(dict(id=path + ('#' + route if len(routes) > 1 else ''), kind=kind, source=path,
                    **({'routeClass': route} if route else {}),
                    implementation='implemented-preview' if '/frameleaf/' in path else 'existing-native',
                    frameleafRedesign='review-only-preview' if '/frameleaf/' in path else 'pending',
                    runtimeQualification='not-device-qualified', sourceAvailability='committed-source',
                    qualification=COMMITTED_QUALIFICATION))
    for file in sorted((ROOT / 'web/src/routes').rglob('+page.svelte')):
        path = str(file.relative_to(ROOT))
        parts = list(file.relative_to(ROOT / 'web/src/routes').parts[:-1])
        clean = [part for part in parts if not part.startswith('(')]
        area = clean[0] if clean else 'root'
        native = COUNTERPARTS.get(area, [])
        entries.append(dict(id=path, kind='web-page', source=path, area=area,
            audience='administrator' if area == 'admin' else 'end-user',
            nativeParity='partial-existing-counterpart' if native else 'not-implemented',
            nativeEvidence=native, frameleafRedesign='pending', runtimeQualification='not-device-qualified',
            sourceAvailability='committed-source', qualification=COMMITTED_QUALIFICATION))
    for file in sorted((ROOT / 'web/src').rglob('*.svelte')):
        path = str(file.relative_to(ROOT))
        # Individually inventory server administration controls, beyond the route shell.
        if (('/settings/' in path and 'admin' in path) or '/admin/system-settings/' in path or '/admin-settings/' in path) and not file.name.startswith('+'):
            entries.append(dict(id=path, kind='web-admin-setting', source=path,
                nativeParity='not-implemented', frameleafRedesign='pending', runtimeQualification='not-device-qualified',
                sourceAvailability='committed-source', qualification=COMMITTED_QUALIFICATION))
    validate_committed_entries(entries)
    preserved = preserved_requirements()
    all_entries = entries + preserved['entries']
    counts = Counter(entry['kind'] for entry in all_entries)
    return dict(schemaVersion=2, product='Frameleaf', nativeShellFlag='FRAMELEAF_NATIVE_PREVIEW',
        assessment='Committed source inventory plus hashed dirty-checkout preservation requirements; neither source presence nor preservation ownership claims complete parity, runtime availability, or device qualification.',
        acceptance={'fullNativeParity': False, 'nativeStudio': False, 'nativeStudioProjectReview': False, 'webviewCountsAsNative': False,
            'releaseSigningQualified': False, 'iosBackupDeviceQualified': False, 'androidBackupDeviceQualified': False},
        counts={'committedEntries': len(entries), 'preservedDirtyRequirements': len(preserved['entries']),
            'totalPreservationRows': len(all_entries), 'byKind': dict(sorted(counts.items()))},
        preservedEvidence={'path': str(PRESERVED.relative_to(ROOT)), 'preservedCheckoutHead': preserved['preservedCheckoutHead'],
            'reviewedCleanBaseline': preserved['reviewedCleanBaseline'], 'dirtyInventorySha256': preserved['dirtyInventorySha256'],
            'qualification': 'not-committed-not-qualified'},
        roadmapGaps=[dict(id=id, nativeParity='partial-project-review' if id == 'native-studio' else 'not-implemented', detail=detail) for id, detail in GAPS],
        entrypoints=entries, preservedRequirements=preserved['entries'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--preserved-source-root', type=Path,
        help='Optional read-only preserved checkout used to verify recorded source hashes and byte counts.')
    args = parser.parse_args()
    if args.preserved_source_root:
        preserved_requirements(args.preserved_source_root.resolve())
    expected = canonical_json(snapshot())
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != expected:
            print('Native parity inventory is stale. Run python3 scripts/frameleaf-mobile-inventory.py.', file=sys.stderr)
            return 1
        result = json.loads(expected)
        validate_issue_map(result, expected)
        print(f'Frameleaf inventory verified: {len(result["entrypoints"])} committed source entries and '
              f'{len(result["preservedRequirements"])} preserved dirty-only requirements.')
    else:
        OUTPUT.write_text(expected)
    return 0

if __name__ == '__main__':
    sys.exit(main())
