#!/usr/bin/env python3
"""Compile native gettext catalogues and create a deterministic installable ZIP."""
import argparse
import json
import re
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ['en_US', 'fr_FR', 'es_ES', 'de_DE', 'it_IT', 'pt_PT', 'nl_NL', 'pl_PL', 'sv_SE', 'da_DK', 'nb_NO']

def catalogue(path):
    pairs = re.findall(r'^msgid (".*")\nmsgstr (".*")$', path.read_text(), re.M)
    return {json.loads(key): json.loads(value) for key, value in pairs}

def mo(messages):
    entries = sorted(messages.items())
    keys = b''.join(key.encode() + b'\0' for key, _ in entries)
    values = b''.join(value.encode() + b'\0' for _, value in entries)
    base = 28 + 16 * len(entries)
    table_keys, table_values, key_offset, value_offset = [], [], base, base + len(keys)
    for key, value in entries:
        kb, vb = key.encode(), value.encode()
        table_keys.extend((len(kb), key_offset)); table_values.extend((len(vb), value_offset))
        key_offset += len(kb) + 1; value_offset += len(vb) + 1
    return struct.pack('<7I', 0x950412DE, 0, len(entries), 28, 28 + 8 * len(entries), 0, base) + struct.pack('<' + 'I' * (4 * len(entries)), *(table_keys + table_values)) + keys + values

def validate():
    source = ROOT / 'frameleaf-connect'
    strings = {s for path in source.rglob('*.php') for s in re.findall(r"(?:__|esc_html__|esc_attr__)\('((?:\\.|[^'])*)', 'frameleaf-connect'\)", path.read_text())}
    strings |= {'Frameleaf Connect', 'Import authorized Frameleaf images into the WordPress Media Library.'}
    for locale in LOCALES:
        messages = catalogue(source / 'languages' / f'frameleaf-connect-{locale}.po')
        assert set(messages) == strings | {''}, f'{locale}: missing or stale messages'
        assert all(messages.values()), f'{locale}: empty message'
        if locale != 'en_US':
            assert all(messages[key] != key for key in strings - {'Frameleaf', 'Library', 'Frameleaf Connect'}), f'{locale}: untranslated value'
    for language in ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb_NO']:
        assert (ROOT / 'help' / f'{language}.md').is_file(), f'{language}: missing installation guide'
    return len(strings)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    count = validate()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(args.output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((ROOT / 'frameleaf-connect').rglob('*')):
                if not path.is_file(): continue
                name = path.relative_to(ROOT).as_posix()
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o644 << 16
                archive.writestr(entry, path.read_bytes())
                if path.suffix == '.po':
                    entry = zipfile.ZipInfo(name[:-3] + '.mo', date_time=(1980, 1, 1, 0, 0, 0))
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(entry, mo(catalogue(path)))
            for path in sorted((ROOT / 'help').glob('*.md')):
                entry = zipfile.ZipInfo('frameleaf-connect/help/' + path.name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, path.read_bytes())
        print(f'Created {args.output}')
    print(f'Validated {count} messages across {len(LOCALES)} locales')

if __name__ == '__main__': main()
