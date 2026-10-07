"""Synthetic 12-bit ISO regression. Requires FFmpeg with 12-bit libx265.
Run: python3 generate.py /path/to/ffmpeg /path/to/output-directory
Never uses Frameleaf to generate reference pixels.
"""
from pathlib import Path
import struct, sys, subprocess, hashlib, json, math
root=Path(sys.argv[2]).resolve(); root.mkdir(parents=True, exist_ok=True)
ffmpeg=sys.argv[1]
template=Path(__file__).resolve().parent.parent/'iso-gain-map-10bit.heic'
assert hashlib.sha256(template.read_bytes()).hexdigest()=='b127f83ff2043d1e8f220518c02d3ec466cc95556082b93f100925de3441a072'
raw=bytearray()
for tile in range(2):
    for y in range(512):
        for x in range(512):
            code=min(4095,4*(tile*512+x)+y%4)*16
            raw+=struct.pack('<3H',code,code,code)
(root/'iso-12bit-tiles.rgb').write_bytes(raw)
subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgb48le','-video_size','512x512','-framerate','1','-i',str(root/'iso-12bit-tiles.rgb'),'-frames:v','2','-c:v','libx265','-pix_fmt','gbrp12le','-preset','ultrafast','-x265-params','lossless=1:keyint=1:pools=1:frame-threads=1','-color_range','pc','-color_primaries','smpte432','-color_trc','iec61966-2-1','-colorspace','0','-tag:v','hvc1','-y',str(root/'iso-12bit-tiles.mp4')],check=True)

def boxes(data):
    at=0
    while at<len(data):
        size,kind=struct.unpack_from('>I4s',data,at); header=8
        if size==1: size=struct.unpack_from('>Q',data,at+8)[0]; header=16
        if size==0: size=len(data)-at
        assert size>=header and at+size<=len(data)
        yield kind,data[at+header:at+size]; at+=size

def box(kind,data): return struct.pack('>I4s',8+len(data),kind)+data
mp4=dict(boxes((root/'iso-12bit-tiles.mp4').read_bytes()))
stbl=mp4[b'moov']
for tag in [b'trak',b'mdia',b'minf',b'stbl']: stbl=dict(boxes(stbl))[tag]
stbl=dict(boxes(stbl)); stsz=stbl[b'stsz']; assert struct.unpack_from('>II',stsz,4)==(0,2)
lengths=struct.unpack_from('>II',stsz,12); assert sum(lengths)==len(mp4[b'mdat'])
frames=[mp4[b'mdat'][:lengths[0]],mp4[b'mdat'][lengths[0]:]]
sample=dict(boxes(stbl[b'stsd'][8:]))[b'hvc1']; config=dict(boxes(sample[78:]))[b'hvcC']
source=template.read_bytes()
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
props[4]=(b'pixi',bytes(4)+bytes([3,12,12,12])); props[8]=(b'hvcC',config)
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
(root/'source.heic').write_bytes(result)


source=(root/'source.heic').read_bytes(); meta=dict(boxes(dict(boxes(source))[b'meta'][4:])); loc=meta[b'iloc'];at=8;frames=[]
for _ in range(struct.unpack_from('>H',loc,6)[0]):
    item,method,ref,n=struct.unpack_from('>4H',loc,at);at+=8;off,size=struct.unpack_from('>II',loc,at);at+=8
    if item in (4,5):frames.append(source[off:off+size])
assert len(frames)==2
config=list(boxes(dict(boxes(meta[b'iprp']))[b'ipco']))[9][1]
original=list(boxes((root/'iso-12bit-tiles.mp4').read_bytes())); offset=0

def rewrite(data):
    out=b''
    for k,v in boxes(data):
        if k in (b'moov',b'trak',b'mdia',b'minf',b'stbl'):v=rewrite(v)
        elif k==b'stsd':
            kind,sample=next(boxes(v[8:])); sample=sample[:78]+b''.join(box(a,config if a==b'hvcC' else b) for a,b in boxes(sample[78:]));v=v[:8]+box(kind,sample)
        elif k==b'stsz':v=v[:12]+struct.pack('>II',*(len(f) for f in frames))
        elif k==b'stco':
            assert struct.unpack_from('>I',v,4)[0]==1
            v=v[:8]+struct.pack('>I',offset)
        elif k==b'mdat':v=b''.join(frames)
        out+=box(k,v)
    return out
first=rewrite((root/'iso-12bit-tiles.mp4').read_bytes());cursor=0
for k,v in boxes(first):
    if k==b'mdat':offset=cursor+8;break
    cursor+=len(v)+8
(root/'iso-12bit-map-reference.mp4').write_bytes(rewrite((root/'iso-12bit-tiles.mp4').read_bytes()))

for encoded,decoded,fmt in [('iso-12bit-tiles.mp4','primary.rgb','rgb48le'),('iso-12bit-map-reference.mp4','gain.rgb','rgb24')]:
    subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-i',str(root/encoded),'-f','rawvideo','-pix_fmt',fmt,'-y',str(root/decoded)],check=True)
raw=(root/'primary.rgb').read_bytes(); gain=(root/'gain.rgb').read_bytes()
assert len(raw)==2*512*512*6 and len(gain)==2*512*512*3
source=(root/'source.heic').read_bytes(); d=source[source.index(b'idat')+4+16:]
assert d[:6]==bytes(5)+b'\xc0'
nums=[a/b for a,b in struct.iter_unpack('>iI',d[6:6+136])]
channels=[nums[2+i*5:7+i*5] for i in range(3)]
rows=[4,5,6,7,12,20,28]; rgb=[]
for y in rows:
    row=[]
    for x in range(2,1024,4):
        values=[]
        for c in range(3):
            at=(x//512*512*512+y*512+x%512)*3+c
            code=round(struct.unpack_from('<H',raw,at*2)[0]*4095/65535)
            assert code==min(4095,4*x+y%4)
            q=code/4095
            linear=q/12.92 if q<=.04045 else ((q+.055)/1.055)**2.4
            lo,hi,gamma,baseoffset,altoffset=channels[c]
            values.append((linear+baseoffset)*2**(lo+(hi-lo)*(gain[at]/255)**(1/gamma))-altoffset)
        row.append(values)
    rgb.append(row)
ref={'sourceSha256':hashlib.sha256(source).hexdigest(),'decoder':'FFmpeg 7.1.3-6, independent HEVC primary/map decode; ISO 21496 scalar reconstruction','colorSpace':'extended-linear-bt2020','width':1024,'height':32,'sampleY':rows,'sampleStep':4,'sampleOffset':2,'rgb':rgb}
(root/'reference.json').write_text(json.dumps(ref,indent=2)+'\n')
print(ref['sourceSha256'])
