"""Synthetic HDR-base ISO fixtures; not a camera fixture."""
from pathlib import Path
import struct, sys
root=Path(__file__).resolve().parent

def boxes(data):
    at=0
    while at<len(data):
        size,kind=struct.unpack_from('>I4s',data,at); header=8
        if size==1: size=struct.unpack_from('>Q',data,at+8)[0]; header=16
        if size==0: size=len(data)-at
        assert size>=header and at+size<=len(data)
        yield kind,data[at+header:at+size]; at+=size

def box(kind,data): return struct.pack('>I4s',8+len(data),kind)+data
pq=(root/('hlg-base-authored.heic' if '--hlg' in sys.argv else 'pq-p3-colors.heic' if '--colors' in sys.argv else 'pq-base-authored.heic')).read_bytes()
pqmeta=dict(boxes(dict(boxes(pq))[b'meta'][4:]))
loc=pqmeta[b'iloc']; count=struct.unpack_from('>H',loc,6)[0]; at=8; frames=[]
for _ in range(count):
    item,method,reference,extents=struct.unpack_from('>4H',loc,at);at+=8
    offset,size=struct.unpack_from('>II',loc,at);at+=8
    if item in (1,2): frames.append(pq[offset:offset+size])
assert len(frames)==2
pqprops=list(boxes(dict(boxes(pqmeta[b'iprp']))[b'ipco']))
config=pqprops[5][1]
source=(root.parent/'iso-gain-map-10bit.heic').read_bytes()
outer=list(boxes(source)); meta=dict(outer)[b'meta']; entries=list(boxes(meta[4:])); fields=dict(entries)
assert fields[b'iloc'][:6]==b'\x01\0\0\0\x44\0'
loc=bytearray(fields[b'iloc']); count=struct.unpack_from('>H',loc,6)[0]; at=8; replacements={1:frames[0],2:frames[1]}; samples=[]
for _ in range(count):
    item,method,reference,extents=struct.unpack_from('>4H',loc,at); at+=8
    assert reference==0 and extents==1 and method in (0,1)
    offset,size=struct.unpack_from('>II',loc,at)
    if method==0: samples.append((offset,at,replacements.get(item,source[offset:offset+size])))
    at+=8
assert at==len(loc); samples.sort(); data=b''.join(v for _,_,v in samples)
iprp=list(boxes(fields[b'iprp'])); props=list(boxes(dict(iprp)[b'ipco'])); assert props[4][0]==b'pixi' and props[8][0]==b'hvcC'
props[0]=(b'colr',pqprops[0][1]); props[7]=(b'colr',b'nclx'+struct.pack('>3HB',9,13,0,128))
metadata=bytearray(fields[b'idat']);metadata[21]=0x84 if '--alternate' in sys.argv else 0xc4
# HDR base headroom 3 stops; SDR alternate 0. Constant ratio 8, distinct offsets.
headroom=200000 if "--hlg" in sys.argv else 300000
struct.pack_into('>4I',metadata,22,headroom,100000,0,100000)
for channel in range(3):
    at=38+channel*40
    struct.pack_into('>10I',metadata,at,headroom+channel*100000 if '--alternate' in sys.argv else headroom,100000,headroom+channel*100000 if '--alternate' in sys.argv else headroom,100000,100000,100000,2,100000,1,100000)
fields[b'idat']=bytes(metadata)
props[4]=(b'pixi',bytes(4)+bytes([3,10,10,10])); props[8]=(b'hvcC',config)
fields[b'iprp']=b''.join(box(k,b''.join(box(a,b) for a,b in props) if k==b'ipco' else v) for k,v in iprp)
fields[b'iloc']=bytes(loc)
def output():
    changed=meta[:4]+b''.join(box(k,fields[k]) for k,_ in entries)
    return b''.join(box(k,changed if k==b'meta' else data if k==b'mdat' else v) for k,v in outer)
first=output(); header=0
for kind,payload in boxes(first):
    if kind==b'mdat': break
    header+=len(payload)+8
cursor=header+8
for _,position,value in samples:
    struct.pack_into('>II',loc,position,cursor,len(value)); cursor+=len(value)
fields[b'iloc']=bytes(loc); result=output(); assert len(result)==len(first)
(root/('hlg-candidate.heic' if '--hlg' in sys.argv else 'pq-alternate.heic' if '--alternate' in sys.argv else 'pq-colors.heic' if '--colors' in sys.argv else 'pq-candidate.heic')).write_bytes(result)
print('Synthetic fixture', len(result), 'bytes')
