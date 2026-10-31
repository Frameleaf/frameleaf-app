"""Synthetic ISO fixture: retain HEVC samples, replace the legacy map association."""
from pathlib import Path
import struct
import hashlib
import sys
p = Path(__file__).resolve().parent

def boxes(data):
    offset = 0
    while offset < len(data):
        size, kind = struct.unpack_from('>I4s', data, offset)
        header = 8
        if size == 1:
            size = struct.unpack_from('>Q', data, offset + 8)[0]
            header = 16
        elif size == 0:
            size = len(data) - offset
        assert size >= header and offset + size <= len(data)
        yield kind, data[offset + header:offset + size]
        offset += size

def box(kind, payload):
    return struct.pack('>I4s', len(payload) + 8, kind) + payload

template = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(template).hexdigest() == '391cb5eced34d9cc12114a255bd203d2cbcbf3f94cc49627749c42d5b5ab35c8'
original_meta = dict(boxes(template))[b'meta'][4:]
original = dict(boxes(original_meta))
metadata = original[b'idat'][16:158]
assert len(metadata) == 142 and metadata[0] == 0
profile = dict(boxes(original[b'iprp']))[b'ipco']
profile = list(boxes(profile))[6][1]
source = Path(sys.argv[2]).read_bytes()

def rewrite(data, delta=0):
    result = b''
    for kind, payload in boxes(data):
        if kind == b'ftyp':
            payload += b'tmap'
        elif kind == b'meta':
            payload = payload[:4] + rewrite(payload[4:], delta) + box(b'grpl', original[b'grpl'])
        elif kind == b'iprp':
            payload = rewrite(payload, delta)
        elif kind == b'iinf':
            count = struct.unpack_from('>H', payload, 4)[0]
            assert payload[:4] == bytes(4) and count == 6
            payload = payload[:4] + struct.pack('>H', 7) + payload[6:]
            payload += box(b'infe', b'\x02\0\0\0' + struct.pack('>HH', 7, 0) + b'tmap\0')
        elif kind == b'iref':
            assert payload[:4] == bytes(4)
            payload = payload[:4] + b''.join(box(k, v) for k, v in boxes(payload[4:]) if k != b'auxl')
            payload += box(b'dimg', struct.pack('>4H', 7, 2, 3, 4))
        elif kind == b'ipco':
            assert len(list(boxes(payload))) == 10
            payload += box(b'colr', profile)
        elif kind == b'ipma':
            assert payload[:4] == bytes(4)
            count = struct.unpack_from('>I', payload, 4)[0]
            offset, updated = 8, payload[:4] + struct.pack('>I', count + 1)
            for _ in range(count):
                item, length = struct.unpack_from('>HB', payload, offset)
                offset += 3
                props = payload[offset:offset + length]
                offset += length
                if item == 4:
                    props = bytes(v for v in props if v & 127 != 8)
                updated += struct.pack('>HB', item, len(props)) + props
            assert offset == len(payload)
            payload = updated + struct.pack('>HB', 7, 4) + bytes([139, 3, 5, 132])
        elif kind == b'idat':
            assert len(payload) == 8
            payload += metadata
        elif kind == b'iloc':
            assert payload[:6] == b'\x01\0\0\0\x44\0'
            count = struct.unpack_from('>H', payload, 6)[0]
            updated = bytearray(payload)
            struct.pack_into('>H', updated, 6, count + 1)
            offset = 8
            for _ in range(count):
                item, method, reference, extents = struct.unpack_from('>4H', payload, offset)
                assert reference == 0 and method in (0, 1)
                offset += 8
                for _ in range(extents):
                    if method == 0:
                        location = struct.unpack_from('>I', payload, offset)[0]
                        struct.pack_into('>I', updated, offset, location + delta)
                    offset += 8
            assert offset == len(payload)
            payload = bytes(updated) + struct.pack('>4H2I', 7, 1, 0, 1, 8, len(metadata))
        result += box(kind, payload)
    return result

changed = rewrite(source)
changed = rewrite(source, len(changed) - len(source))
output = Path(sys.argv[3])
output.write_bytes(changed)
assert dict(boxes(source))[b'mdat'] == dict(boxes(changed))[b'mdat']
print(output, len(changed))
