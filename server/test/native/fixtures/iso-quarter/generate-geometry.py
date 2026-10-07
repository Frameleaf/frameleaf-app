"""Synthetic ISO geometry corpus; encoded sample payloads remain byte-identical."""
from pathlib import Path
import json
import struct
p = Path(__file__).resolve().parent

def boxes(data):
    offset = 0
    while offset < len(data):
        size, kind = struct.unpack_from('>I4s', data, offset)
        assert size >= 8 and offset + size <= len(data)
        yield kind, data[offset + 8:offset + size]
        offset += size

def box(kind, payload):
    return struct.pack('>I4s', len(payload) + 8, kind) + payload

source = (p / 'source.heic').read_bytes()
crop = ['crop', 257, 9, 512, 16]
cases = [[crop], [crop, ['rotate', 90]], [crop, ['rotate', 180]], [crop, ['rotate', 270]],
         [crop, ['mirror', 'horizontal']], [crop, ['mirror', 'vertical']],
         [['rotate', 90], ['crop', 9, 257, 16, 512]],
         [['mirror', 'horizontal'], crop], [crop, ['rotate', 90], ['mirror', 'vertical']]]
for number, operations in enumerate(cases):
    w, h, properties = 1024, 32, b''
    for op in operations:
        if op[0] == 'crop':
            _, left, top, width, height = op
            assert left >= 0 and top >= 0 and left + width <= w and top + height <= h
            properties += box(b'clap', struct.pack('>4I4i', width, 1, height, 1,
                left - (w - width) // 2, 1, top - (h - height) // 2, 1))
            w, h = width, height
        elif op[0] == 'rotate':
            properties += box(b'irot', bytes([op[1] // 90]))
            if op[1] in (90, 270): w, h = h, w
        else:
            properties += box(b'imir', bytes([1 if op[1] == 'horizontal' else 0]))
    def rewrite(data, delta=0):
        output = b''
        for kind, payload in boxes(data):
            if kind == b'meta': payload = payload[:4] + rewrite(payload[4:], delta)
            elif kind == b'iprp': payload = rewrite(payload, delta)
            elif kind == b'ipco':
                assert len(list(boxes(payload))) == 11
                payload += properties
            elif kind == b'ipma':
                assert payload[:4] == bytes(4)
                offset, updated = 8, payload[:8]
                for _ in range(struct.unpack_from('>I', payload, 4)[0]):
                    item, length = struct.unpack_from('>HB', payload, offset)
                    offset += 3
                    props = payload[offset:offset + length]
                    offset += length
                    if item in (3, 7): props += bytes(128 + 12 + i for i in range(len(operations)))
                    updated += struct.pack('>HB', item, len(props)) + props
                assert offset == len(payload)
                payload = updated
            elif kind == b'iloc':
                assert payload[:6] == b'\x01\0\0\0\x44\0'
                updated, offset = bytearray(payload), 8
                for _ in range(struct.unpack_from('>H', payload, 6)[0]):
                    item, method, reference, extents = struct.unpack_from('>4H', payload, offset)
                    assert method in (0, 1) and reference == 0
                    offset += 8
                    for _ in range(extents):
                        if method == 0:
                            struct.pack_into('>I', updated, offset, struct.unpack_from('>I', payload, offset)[0] + delta)
                        offset += 8
                assert offset == len(payload)
                payload = bytes(updated)
            output += box(kind, payload)
        return output
    changed = rewrite(source)
    changed = rewrite(source, len(changed) - len(source))
    assert dict(boxes(changed))[b'mdat'] == dict(boxes(source))[b'mdat']
    (p / f'geometry-{number}.heic').write_bytes(changed)
(p / 'geometry.json').write_text(json.dumps(cases))
