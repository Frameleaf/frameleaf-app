// Independent display-light oracles through the managed graph and linear brightness/contrast/exposure.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testedSource } from './lib/working-domain-report.mjs';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';
const { chromium } = createRequire(new URL('../engine/package.json', import.meta.url))('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const source = await testedSource(new URL(import.meta.url));
const SIZE = 64;
const FPS = 30;
// Three solid ten-frame segments per clip, as R'G'B' signal.
const SEGMENTS = {
  pq: [[0.508078, 0.508078, 0.508078], [0.751827, 0.751827, 0.751827], [0.7, 0.45, 0.25]],
  hlg: [[0.5, 0.5, 0.5], [0.9, 0.9, 0.9], [0.8, 0.55, 0.3]],
};
const TRC = { pq: ['smpte2084', 16], hlg: ['arib-std-b67', 18] };

const dir = mkdtempSync(join(tmpdir(), 'hdr-source-'));
const fixtures = {};
try {
  for (const [transfer, segments] of Object.entries(SEGMENTS)) {
    const frame = (rgb) => {
      const buf = Buffer.alloc(SIZE * SIZE * 6);
      for (let i = 0; i < SIZE * SIZE; i++) {
        rgb.forEach((v, c) => buf.writeUInt16LE(Math.round(v * 65535), i * 6 + c * 2));
      }
      return buf;
    };
    const raw = Buffer.concat(segments.flatMap((rgb) => Array.from({ length: 10 }, () => frame(rgb))));
    const [trc, code] = TRC[transfer];
    const out = join(dir, `${transfer}.mp4`);
    // The server's Studio HDR intermediate settings (server/src/utils/studio-hdr-proxy.ts).
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${SIZE}x${SIZE}`, '-r', String(FPS),
      '-i', '-', '-vf',
      `scale=out_range=tv:out_color_matrix=bt2020,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc:range=tv`,
      '-c:v', 'libsvtav1', '-preset', '10', '-crf', '23',
      '-svtav1-params', `color-primaries=9:transfer-characteristics=${code}:matrix-coefficients=9:color-range=0`,
      '-g', String(FPS), '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', trc,
      '-colorspace', 'bt2020nc', '-color_range', 'tv', '-movflags', '+faststart', '-f', 'mp4', '-y', out,
    ], { input: raw, env: { ...process.env, SVT_LOG: '1' } });
    fixtures[transfer] = readFileSync(out);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  for (const [transfer, body] of Object.entries(fixtures)) await page.route(`${origin}/hdr-fixture/${transfer}.mp4`, route => route.fulfill({contentType: 'video/mp4', body}));
  await page.route(origin + '/linear-hdr', route => route.fulfill({ contentType: 'text/html', body: `<script type="module">
import R from '/@react-refresh'; R.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>x=>x; window.__vite_plugin_react_preamble_installed__=true;
</script>` }));
  await page.goto(origin + '/linear-hdr');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  const report = await page.evaluate(async () => {
    const { GpuPipelineManager } = await import('/src/features/export/utils/gpu-pipeline-manager.ts');
    const { ColorOutputPipeline } = await import('/src/infrastructure/gpu-color/color-output-pipeline.ts');
    const { HdrRasterSources } = await import('/src/features/export/utils/hdr-raster-sources.ts');
    const { HdrVideoSources, registerHdrSourceUrl } = await import('/src/features/export/utils/hdr-video-sources.ts');
    const { VideoFrameExtractor } = await import('/src/features/export/utils/canvas-video-extractor.ts');
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const { useCompositionsStore } = await import('/src/features/timeline/stores/compositions-store.ts');
    // These equations are independent of managed-color.ts/WGSL and operate on
    // declared physical quantities. Production helpers do not build expectations.
    const decode = v => Math.sign(v) * (Math.abs(v) <= .04045 ? Math.abs(v)/12.92 : ((Math.abs(v)+.055)/1.055)**2.4);
    const encode = v => Math.sign(v) * (Math.abs(v) <= .0031308 ? Math.abs(v)*12.92 : 1.055*Math.abs(v)**(1/2.4)-.055);
    const pq = n => { const y = Math.max(0, Math.min(1, n/10000))**(2610/16384); return ((3424/4096+(2413/4096)*32*y)/(1+(2392/4096)*32*y))**((2523/4096)*128); };
    const invPq = s => { const e=s**(1/((2523/4096)*128)); return 10000*(Math.max(e-3424/4096,0)/((2413/4096)*32-(2392/4096)*32*e))**(1/(2610/16384)); };
    const invHlg = v => v <= .5 ? v*v/3 : (Math.exp((v-.55991073)/.17883277)+.28466892)/12;
    const hlg = v => v <= 1/12 ? Math.sqrt(3*v) : .17883277*Math.log(12*v-.28466892)+.55991073;
    const dot = (a,b) => a.reduce((v,x,i)=>v+x*b[i],0);
    const m709 = [[1.660491,-.587641,-.07285],[-.124551,1.1329,-.008349],[-.018151,-.100579,1.11873]];
    const m2020 = [[.627404,.329282,.043314],[.069097,.91954,.011361],[.016392,.088013,.895595]];
    const ingest = (signal, transfer) => {
      let nits;
      if (transfer==='pq') nits=signal.map(invPq);
      else { const scene=signal.map(invHlg); const gain=1000*Math.max(0,dot([.2627,.678,.0593],scene))**.2; nits=scene.map(v=>v*gain); }
      return m709.map(row=>dot(row,nits)/203);
    };
    const deliver = (linear, target) => {
      if (target==='sdr-display') return linear.map(v=>encode(Math.max(0,Math.min(1,v))));
      const nits=m2020.map(row=>Math.max(0,dot(row,linear))*203);
      if (target==='pq') return nits.map(pq);
      const clipped=nits.map(v=>Math.min(1000,v)); const yd=dot([.2627,.678,.0593],clipped);
      const ys=(yd/1000)**(1/1.2); const gain=1000*ys**.2;
      return clipped.map(v=>hlg(yd>0?Math.min(1,v/gain):0));
    };
    const over = (base, src, alpha) => base.map((v,c)=>v*(1-alpha)+src[c]*alpha);
    const rows=[];
    const record=(name,got,want,budget=.004)=>rows.push({name,got,want,budget});
    const gpu=new GpuPipelineManager('hdr'); await gpu.ensureEffects();
    if (!gpu.effects) throw new Error('WebGPU unavailable');
    gpu.ensureMedia(); gpu.ensureMediaBlend(); gpu.ensureShape(); gpu.ensureCompositor();
    const device=gpu.effects.getDevice(); const output=new ColorOutputPipeline(device);
    const color={workingRange:'hdr',referenceWhiteNits:203,masteringPeakNits:1000,sdrMonitoring:'none'};
    const makeTex=(w,h)=>device.createTexture({size:[w,h],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
    const read=async(tex,target='pq')=>{
      const out=device.createTexture({size:[tex.width,tex.height],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const stride=Math.ceil(tex.width*16/256)*256;
      const buffer=device.createBuffer({size:stride*tex.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try { output.convert(tex,out,target,color); const e=device.createCommandEncoder(); e.copyTextureToBuffer({texture:out},{buffer,bytesPerRow:stride},[tex.width,tex.height]); device.queue.submit([e.finish()]); await buffer.mapAsync(GPUMapMode.READ);
        const raw=new Float32Array(buffer.getMappedRange()); return Array.from({length:tex.height},(_,y)=>Array.from(raw.slice(y*stride/4,y*stride/4+tex.width*4))).flat();
      } finally { buffer.destroy(); out.destroy(); }
    };
    const sample=(rgba,w,x,y=1)=>rgba.slice((y*w+x)*4,(y*w+x)*4+3);
    const params=(w,h)=>({sourceWidth:2,sourceHeight:2,outputWidth:w,outputHeight:h,destRect:{x:0,y:0,width:w,height:h},opacity:1});
    const canvas=new OffscreenCanvas(2,2); const ctx=canvas.getContext('2d'); ctx.fillStyle='#808080'; ctx.fillRect(0,0,1,2);ctx.fillStyle='#ffffff';ctx.fillRect(1,0,1,2);
    const mediaTex=makeTex(4,2); const snapshot=makeTex(2,2);
    try {
      gpu.media.renderSourceToTexture(canvas,mediaTex,params(4,2));
      record('SDR decode before bilinear filtering',sample(await read(mediaTex),4,1),deliver([.75*decode(128/255)+.25,.75*decode(128/255)+.25,.75*decode(128/255)+.25],'pq'));
      gpu.effects.applyEffectsToTexture(canvas,[],snapshot);
      record('text/Lottie snapshot SDR ingress',sample(await read(snapshot),2,0),deliver([decode(128/255),decode(128/255),decode(128/255)],'pq'));
      const contrastEffect=[{id:'contrast',type:'gpu-contrast',name:'contrast',enabled:true,params:{amount:1.5}}];
      gpu.effects.applyEffectsToTexture(canvas,contrastEffect,snapshot);
      record('contrast decodes authored SDR before linear pivot/gain',sample(await read(snapshot),2,0),deliver(Array(3).fill((decode(128/255)-.5)*1.5+.5),'pq'));
      const brightness=[{id:'brightness',type:'gpu-brightness',name:'brightness',enabled:true,params:{amount:.125}}];
      gpu.effects.applyEffectsToTexture(canvas,brightness,snapshot);
      record('brightness decodes authored SDR before linear addition',sample(await read(snapshot),2,0),deliver(Array(3).fill(decode(128/255)+.125),'pq'));
      const encoded=device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      try {
        device.queue.writeTexture({texture:encoded},new Uint8Array(Array.from({length:4},()=>[128,128,128,255]).flat()),{bytesPerRow:8},[2,2]);
        gpu.effects.applyTextureEffectsToTexture(encoded,contrastEffect,snapshot,2,2);
        record('rgba8 texture decode precedes contrast',sample(await read(snapshot),2,0),deliver(Array(3).fill((decode(128/255)-.5)*1.5+.5),'pq'));
        gpu.effects.applyTextureEffectsToTexture(encoded,[...brightness,{id:'disabled',type:'gpu-exposure',name:'disabled',enabled:false,params:{}}],snapshot,2,2);
        record('rgba8 texture decode precedes brightness; disabled exposure is ignored',sample(await read(snapshot),2,0),deliver(Array(3).fill(decode(128/255)+.125),'pq'));
      }finally{encoded.destroy();}
    } finally {mediaTex.destroy();snapshot.destroy();}
    const authoredShape=makeTex(16,16);
    try {
      gpu.shape.renderShapeToTexture(authoredShape,{outputWidth:16,outputHeight:16,transformRect:{x:0,y:0,width:16,height:16},rotationRad:0,opacity:1,shapeType:'rectangle',fillColor:[128/255,128/255,128/255,1],gradientEndColor:[1,1,1,1],gradientAngleRad:0,strokeWidth:0});
      record('shape endpoints linear before gradient interpolation',sample(await read(authoredShape),16,8,8),deliver(Array(3).fill(decode(128/255)*(1-8.5/16)+8.5/16),'pq'));
      gpu.shape.renderShapeToTexture(authoredShape,{outputWidth:16,outputHeight:16,transformRect:{x:0,y:0,width:16,height:16},rotationRad:0,opacity:1,shapeType:'rectangle',fillColor:[1,1,1,1],strokeColor:[128/255,128/255,128/255,1],strokeWidth:2});
      record('authored stroke SDR ingress',sample(await read(authoredShape),16,0,8),deliver(Array(3).fill(decode(128/255)),'pq'));
    }finally{authoredShape.destroy();}

    const hdrInputs={};
    const sourceRgb={pq:[.7,.45,.25],hlg:[.8,.55,.3]};
    const linear={};
    for(const transfer of ['pq','hlg']) {
      const codes=sourceRgb[transfer].map(v=>Math.round(v*65535)); const signal=codes.map(v=>v/65535);
      hdrInputs[transfer]={width:16,height:16,transfer,rgb:new Uint16Array(Array.from({length:256},()=>codes).flat())}; linear[transfer]=ingest(signal,transfer);
      const source=new HdrRasterSources({[transfer]:hdrInputs[transfer]},()=>device);
      try { const tex=source.frameTexture(transfer,203).texture;
        for(const target of ['pq','hlg','sdr-display']) record(`${transfer} source to ${target}`,sample(await read(tex,target),16,8,8),deliver(linear[transfer],target));
        const changed=source.frameTexture(transfer,100).texture;
        record(`${transfer} raster cache reference white`,sample(await read(changed),16,8,8),deliver(linear[transfer].map(v=>v*203/100),'pq'));

      } finally { source.dispose(); }
    }
    const videoReferences = {};
    for (const transfer of ['pq', 'hlg']) {
      const url = `/hdr-fixture/${transfer}.mp4`;
      const item = { id: `video-${transfer}`, mediaId: `video-${transfer}` };
      const probe = new VideoFrameExtractor(url, `oracle-${transfer}`);
      const sources = new HdrVideoSources(() => device);
      registerHdrSourceUrl(item.mediaId, url);
      try {
        if (!await probe.init()) throw new Error(`${transfer} video fixture did not open`);
        for (const segment of [0, 1, 2]) {
          const time = (segment * 10 + 5) / 30;
          const frame = await probe.captureHdrFrame(time);
          if (!frame || frame === 'unsupported') throw new Error(`${transfer} video is unavailable`);
          const u16 = (plane, x, y) => { const {offset, stride} = frame.layout[plane]; const i = offset+y*stride+x*2; return frame.data[i] | frame.data[i+1]<<8; };
          const chroma = plane => { const at=(32+.5)*.5-.5, lo=Math.floor(at), w=at-lo; const row=y=>u16(plane,lo,y)*(1-w)+u16(plane,lo+1,y)*w; return row(lo)*(1-w)+row(lo+1)*w; };
          const yn=(u16(0,32,32)-64)/876, cb=(chroma(1)-512)/896, cr=(chroma(2)-512)/896;
          const r=yn+1.4746*cr, b=yn+1.8814*cb, g=(yn-.2627*r-.0593*b)/.678;
          const want=ingest([r,g,b].map(v=>Math.max(0,Math.min(1,v))),transfer);
          if (segment===2) videoReferences[transfer]=want;
          const source=await sources.frameTexture(item,time,203);
          if (!source) throw new Error(`${transfer} video upload was refused`);
          for (const target of ['pq','hlg','sdr-display']) record(`${transfer} decoded video ${segment} to ${target}`,sample(await read(source.texture,target),64,32,32),deliver(want,target));
          const changed=await sources.frameTexture(item,time,100);
          if (!changed) throw new Error(`${transfer} reference-white reupload was refused`);
          record(`${transfer} same-frame video cache reference white`,sample(await read(changed.texture),64,32,32),deliver(want.map(v=>v*203/100),'pq'));
        }
      } finally { probe.dispose(); sources.dispose(); registerHdrSourceUrl(item.mediaId,null); }
    }
    const shape=(id,fillColor,opacity=1,extra={})=>({id,type:'shape',trackId:id,from:0,durationInFrames:60,shapeType:'rectangle',fillColor,strokeEnabled:false,strokeWidth:0,transform:{x:0,y:0,width:16,height:16,rotation:0,opacity},...extra});
    const image=(id,opacity)=>({id,type:'image',mediaId:id,trackId:id,from:0,durationInFrames:60,src:'',sourceWidth:16,sourceHeight:16,transform:{x:0,y:0,width:16,height:16,rotation:0,opacity}});
    const track=(item,order)=>({id:item.trackId,name:item.id,height:60,locked:false,visible:true,muted:false,solo:false,order,items:[item]});
    const comp=tracks=>({fps:30,width:16,height:16,durationInFrames:60,backgroundColor:'#333333',colorManagement:color,tracks,transitions:[],keyframes:[]});
    const render=async(name,composition,want,extra={},frame=0)=>{
      const c=new OffscreenCanvas(16,16); const renderer=await createCompositionRenderer(composition,c,c.getContext('2d'),{mode:'export',hdrRasters:hdrInputs,...extra});
      try { await renderer.preload?.(); for(const target of ['pq','hlg','sdr-display']) {const f=await renderer.renderFrameSignal(frame,target);record(`${name} ${target}`,sample(Array.from(f.rgba),16,8,8),deliver(want,target));} }
      finally {renderer.dispose();}
    };
    const background=[.2,.2,.2].map(decode);const graphic=[.4,.6,.8].map(decode);
    const vibrate=amount=>[{id:'vibrance',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-vibrance',params:{amount}}}];
    // Signed linear colour: chroma weight uses magnitude, never a potentially zero signed maximum.
    const vibrant=(rgb,amount)=>{const hi=Math.max(...rgb),lo=Math.min(...rgb),scale=Math.max(...rgb.map(Math.abs),1e-6);const weight=1-Math.min(1,Math.max(0,(hi-lo)/scale));const gray=dot([.299,.587,.114],rgb);return rgb.map(v=>Math.max(-65504,Math.min(65504,gray+(v-gray)*(1+amount*weight))));};
    for(const amount of [-1,0,.5,1]) {
      for(const opacity of [0,.5,1]) await render(`vibrance graphic ${amount} alpha ${opacity}`,comp([track(shape('vibrance-alpha','#6699cc',opacity,{effects:vibrate(amount)}),0)]),over(background,vibrant(graphic,amount),opacity));
      for(const transfer of ['pq','hlg']) await render(`vibrance ${transfer} signed headroom ${amount}`,comp([track({...image(transfer,.6),effects:vibrate(amount)},0)]),over(background,vibrant(linear[transfer],amount),.6));
    }
    const temperature=(temperature,tint)=>[{id:'temperature',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-temperature',params:{temperature,tint}}}];
    const tempered=(rgb,T,Q)=>rgb.map((v,c)=>v+[.1*T+.05*Q,-.1*Q,-.1*T+.05*Q][c]);
    for (const opacity of [0,.25,.5,1]) await render(`temperature before straight alpha ${opacity}`,comp([track(shape('temperature-alpha','#6699cc',opacity,{effects:temperature(1,-1)}),0)]),over(background,tempered(graphic,1,-1),opacity));
    for (const transfer of ['pq','hlg']) await render(`${transfer} raster temperature in project units`,comp([track({...image(transfer,.6),effects:temperature(-1,.5)},0)]),over(background,tempered(linear[transfer],-1,.5),.6));
    const grade=(amount)=>[{id:'contrast',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-contrast',params:{amount}}}];
    const contrast=(rgb,amount)=>rgb.map(v=>(v-.5)*amount+.5);
    const saturate=(amount)=>[{id:'saturation',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-saturation',params:{amount}}}];
    const saturated=(rgb,amount)=>{const gray=dot([.299,.587,.114],rgb);return rgb.map(v=>Math.max(-65504,Math.min(65504,gray+(v-gray)*amount)));};
    await render('SDR decode before artistic linear saturation',comp([track(shape('saturation','#6699cc',.5,{effects:saturate(1.5)}),0)]),over(background,saturated(graphic,1.5),.5));
    const expose=(exposure,offset=0,gamma=1)=>[{id:'exposure',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-exposure',params:{exposure,offset,gamma}}}];
    const exposed=(rgb,exposure,offset=0,gamma=1)=>rgb.map(v=>{const x=v*2**exposure+offset;return Math.max(-65504,Math.min(65504,Math.sign(x)*Math.abs(x)**(1/gamma)));});
    await render('root exposure one EV doubles linear white',comp([track(shape('exposure-white','#ffffff',.5,{effects:expose(1)}),0)]),over(background,[2,2,2],.5));
    await render('SDR decode before exposure offset and signed gamma',comp([track(shape('exposure','#6699cc',.5,{effects:expose(1,.125,2)}),0)]),over(background,exposed(graphic,1,.125,2),.5));
    await render('contrast pivot is 101.5 nits; zero gain preserves alpha',comp([track(shape('contrast-pivot','#6699cc',.5,{effects:grade(0)}),0)]),over(background,[.5,.5,.5],.5));
    const lift=(amount)=>[{id:'brightness',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-brightness',params:{amount}}}];
    await render('root brightness before straight alpha',comp([track(shape('bright','#6699cc',.5,{effects:lift(.125)}),0)]),over(background,graphic.map(v=>v+.125),.5));
    await render('root signed HDR brightness',comp([track({...image('pq',.6),effects:lift(-.125)},0)]),over(background,linear.pq.map(v=>v-.125),.6));
    await render('root signed HDR contrast',comp([track({...image('pq',.6),effects:grade(1.5)},0)]),over(background,contrast(linear.pq,1.5),.6));
    await render('root signed HDR exposure',comp([track({...image('pq',.6),effects:expose(-1,-.125,.75)},0)]),over(background,exposed(linear.pq,-1,-.125,.75),.6));
    await render('root signed HDR saturation',comp([track({...image('pq',.6),effects:saturate(1.5)},0)]),over(background,saturated(linear.pq,1.5),.6));
    const reconstructed={};
    for(const gamut of [0,1,2]) {
      const rgb=[-.25,.5,3],id=`reconstructed-${gamut}`;
      const matrix=gamut===2?m709:gamut===1?[[1.224940176,-.224940176,0],[-.042056955,1.042056955,0],[-.019637555,-.078636046,1.098273601]]:[[1,0,0],[0,1,0],[0,0,1]];
      hdrInputs[id]={width:16,height:16,transfer:'linear',rgba:new Float32Array(Array.from({length:256},()=>[...rgb,.5]).flat()),gamut,referenceWhite:100};
      reconstructed[id]=matrix.map(row=>dot(row,rgb)*100/203);
      await render(`gamut ${gamut} reference white before temperature`,comp([track({...image(id,.6),effects:temperature(1,-1)},0)]),over(background,tempered(reconstructed[id],1,-1),.3));
      await render(`reconstructed linear gamut ${gamut} reference white then saturation`,comp([track({...image(id,.6),effects:saturate(1.5)},0)]),over(background,saturated(reconstructed[id],1.5),.3));
    }
    for(const reverse of [false,true]) {
      const temperatureChain=reverse?[...expose(1,.125,2),...temperature(1,-.5)]:[...temperature(1,-.5),...expose(1,.125,2)];
      const temperatureWant=reverse?tempered(exposed(graphic,1,.125,2),1,-.5):exposed(tempered(graphic,1,-.5),1,.125,2);
      await render(`temperature/exposure order ${reverse}`,comp([track(shape('temperature-ordered','#6699cc',.5,{effects:temperatureChain}),0)]),over(background,temperatureWant,.5));
      const chain=reverse?[...lift(.125),...grade(1.5)]:[...grade(1.5),...lift(.125)];
      const want=reverse?contrast(graphic.map(v=>v+.125),1.5):contrast(graphic,1.5).map(v=>v+.125);
      await render(`root brightness/contrast order ${reverse}`,comp([track(shape('ordered','#6699cc',.5,{effects:chain}),0)]),over(background,want,.5));
      const triple=reverse?[...expose(1,.125,2),...grade(1.5),...lift(.125)]:[...lift(.125),...grade(1.5),...expose(1,.125,2)];
      const tripleWant=reverse?contrast(exposed(graphic,1,.125,2),1.5).map(v=>v+.125):exposed(contrast(graphic.map(v=>v+.125),1.5),1,.125,2);
      await render(`root brightness/contrast/exposure order ${reverse}`,comp([track(shape('three-ordered','#6699cc',.5,{effects:triple}),0)]),over(background,tripleWant,.5));
      const ordered=reverse?[...expose(1,.125,2),...saturate(1.5)]:[...saturate(1.5),...expose(1,.125,2)];
      const orderedWant=reverse?saturated(exposed(graphic,1,.125,2),1.5):exposed(saturated(graphic,1.5),1,.125,2);
      await render(`root saturation/exposure order ${reverse}`,comp([track(shape('saturation-ordered','#6699cc',.5,{effects:ordered}),0)]),over(background,orderedWant,.5));
    }
    const temperatureAdjustment={id:'temperature-adjustment',type:'adjustment',trackId:'temperature-adjustment',from:0,durationInFrames:60,effects:temperature(1,-1)};
    await render('temperature adjustment grades mixed sources before source-over',comp([track(temperatureAdjustment,0),track(shape('adjusted-graphic','#6699cc',.25),1),track(image('pq',.6),2)]),over(over(background,tempered(linear.pq,1,-1),.6),tempered(graphic,1,-1),.25));
    const affineEffects = id => [{id,enabled:true,effect:{type:'gpu-effect',gpuEffectType:`gpu-${id}`,params:id==='invert'?{}:{amount:.375}}}];
    const affine = (id,rgb) => {
      if(id==='invert')return rgb.map(v=>1-v);
      const weights=id==='grayscale'?Array.from({length:3},()=>[.299,.587,.114]):[[.393,.769,.189],[.349,.686,.168],[.272,.534,.131]];
      return weights.map((row,c)=>rgb[c]*.625+dot(row,rgb)*.375);
    };
    for(const id of ['grayscale','sepia','invert']) {
      for(const opacity of [0,.25,.5,1])await render(`${id} straight alpha ${opacity}`,comp([track(shape(id,'#6699cc',opacity,{effects:affineEffects(id)}),0)]),over(background,affine(id,graphic),opacity));
      for(const transfer of ['pq','hlg'])await render(`${id} ${transfer} raster`,comp([track({...image(transfer,.6),effects:affineEffects(id)},0)]),over(background,affine(id,linear[transfer]),.6));
      for(const gamut of [0,1,2])await render(`${id} gamut ${gamut} reference white`,comp([track({...image(`reconstructed-${gamut}`,.6),effects:affineEffects(id)},0)]),over(background,affine(id,reconstructed[`reconstructed-${gamut}`]),.3));
      const adjustment={id:`${id}-adjustment`,type:'adjustment',trackId:`${id}-adjustment`,from:0,durationInFrames:60,effects:affineEffects(id)};
      await render(`${id} adjustment mixed source-over`,comp([track(adjustment,0),track(shape(id,'#6699cc',.25),1),track(image('pq',.6),2)]),over(over(background,affine(id,linear.pq),.6),affine(id,graphic),.25));
      const other=id==='grayscale'?expose(1,.125,2):id==='sepia'?temperature(1,-1):lift(.125);
      const transform=rgb=>id==='grayscale'?exposed(rgb,1,.125,2):id==='sepia'?tempered(rgb,1,-1):rgb.map(v=>v+.125);
      for(const reverse of [false,true])await render(`${id} discriminating order ${reverse}`,comp([track(shape(id,'#6699cc',.5,{effects:reverse?[...other,...affineEffects(id)]:[...affineEffects(id),...other]}),0)]),over(background,reverse?affine(id,transform(graphic)):transform(affine(id,graphic)),.5));
    }
    await render('all affine effects composed',comp([track(shape('affine-family','#6699cc',.5,{effects:['grayscale','sepia','invert'].flatMap(affineEffects)}),0)]),over(background,affine('invert',affine('sepia',affine('grayscale',graphic))),.5));
    const mixed=over(over(over(background,linear.pq,.6),linear.hlg,.4),graphic,.25);
    await render('root mixed linear source-over',comp([track(shape('graphic','#6699cc',.25),0),track(image('hlg',.4),1),track(image('pq',.6),2)]),mixed);
    const video=(transfer,opacity)=>({id:`root-video-${transfer}`,mediaId:`root-video-${transfer}`,type:'video',trackId:`root-video-${transfer}`,src:`/hdr-fixture/${transfer}.mp4`,from:0,durationInFrames:60,sourceStart:0,sourceEnd:30,sourceFps:30,sourceDuration:30,speed:1,sourceWidth:64,sourceHeight:64,transform:{x:0,y:0,width:16,height:16,rotation:0,opacity}});
    try {
      for(const transfer of ['pq','hlg']) registerHdrSourceUrl(`root-video-${transfer}`,`/hdr-fixture/${transfer}.mp4`);
      const want=over(over(over(background,videoReferences.pq,.6),videoReferences.hlg,.4),graphic,.25);
      for(const transfer of ['pq','hlg']) await render(`decoded ${transfer} video temperature`,comp([track({...video(transfer,.6),effects:temperature(-1,.5)},0)]),over(background,tempered(videoReferences[transfer],-1,.5),.6),{},25);
      for(const id of ['grayscale','sepia','invert'])for(const transfer of ['pq','hlg'])await render(`${id} decoded ${transfer} video`,comp([track({...video(transfer,.6),effects:affineEffects(id)},0)]),over(background,affine(id,videoReferences[transfer]),.6),{},25);
      await render('decoded HDR video contrast',comp([track({...video('pq',.6),effects:grade(.75)},0)]),over(background,contrast(videoReferences.pq,.75),.6),{},25);
      await render('decoded HDR video exposure',comp([track({...video('pq',.6),effects:expose(-1,-.125,.75)},0)]),over(background,exposed(videoReferences.pq,-1,-.125,.75),.6),{},25);
      await render('decoded HDR video saturation',comp([track({...video('pq',.6),effects:saturate(1.5)},0)]),over(background,saturated(videoReferences.pq,1.5),.6),{},25);
      await render('decoded HDR video brightness',comp([track({...video('pq',.6),effects:lift(.125)},0)]),over(background,videoReferences.pq.map(v=>v+.125),.6),{},25);
      await render('root real decoded video linear source-over',comp([track(shape('graphic','#6699cc',.25),0),track(video('hlg',.4),1),track(video('pq',.6),2)]),want,{},25);
    } finally {for(const transfer of ['pq','hlg'])registerHdrSourceUrl(`root-video-${transfer}`,null);}
    await render('half white is 101.5 nits',{...comp([track(shape('white','#ffffff',.5),0)]),backgroundColor:'#000000'},[.5,.5,.5]);
    const previous=useCompositionsStore.getState().compositions;
    try {
      const children=[track(shape('graphic','#6699cc',.25),0),track(image('pq',.6),1)];
      const nested={...comp(children),id:'linear-inner',name:'linear-inner',items:children.flatMap(t=>t.items)};
      useCompositionsStore.getState().setCompositions([nested]);
      const instance={id:'instance',type:'composition',compositionId:nested.id,compositionWidth:16,compositionHeight:16,trackId:'instance',from:0,durationInFrames:60,transform:{x:0,y:0,width:16,height:16,rotation:0,opacity:.5}};
      // Nested texture is transparent: premultiplied numerator accumulates both
      // children, then the outer instance scales that coverage by .5.
      const alpha=.25+.6*(1-.25);
      const numerator=graphic.map((v,c)=>v*.25+linear.pq[c]*.6*.75);
      const want=background.map((v,c)=>v*(1-alpha*.5)+numerator[c]*.5);
      await render('nested straight alpha source-over',comp([track(instance,0)]),want);
      for(const id of ['grayscale','sepia','invert']) {
        const inner={...nested,id:`${id}-inner`,tracks:[track(shape(id,'#6699cc',.25,{effects:affineEffects(id)}),0),track(image('pq',.6),1)]};
        inner.items=inner.tracks.flatMap(t=>t.items);useCompositionsStore.getState().setCompositions([nested,inner]);
        const graded=affine(id,graphic).map((v,c)=>v*.25+linear.pq[c]*.6*.75);
        await render(`${id} nested child`,comp([track({...instance,compositionId:inner.id},0)]),background.map((v,c)=>v*(1-alpha*.5)+graded[c]*.5));
        await render(`${id} nested instance`,comp([track({...instance,effects:affineEffects(id)},0)]),over(background,affine(id,numerator.map(v=>v/alpha)),alpha*.5));
      }
      const temperatureInner={...nested,id:'temperature-inner',tracks:[track(shape('temperature-child','#6699cc',.25,{effects:temperature(1,-1)}),0),track(image('pq',.6),1)]};
      temperatureInner.items=temperatureInner.tracks.flatMap(t=>t.items);useCompositionsStore.getState().setCompositions([nested,temperatureInner]);
      const temperatureNumerator=tempered(graphic,1,-1).map((v,c)=>v*.25+linear.pq[c]*.6*.75);
      await render('nested child temperature',comp([track({...instance,compositionId:temperatureInner.id},0)]),background.map((v,c)=>v*(1-alpha*.5)+temperatureNumerator[c]*.5));
      const instanceTemperature=tempered(numerator.map(v=>v/alpha),1,-1);
      await render('nested instance temperature preserves coverage',comp([track({...instance,effects:temperature(1,-1)},0)]),background.map((v,c)=>v*(1-alpha*.5)+instanceTemperature[c]*alpha*.5));
      const lifted={...nested,id:'brightness-inner',tracks:[track(shape('bright','#6699cc',.25,{effects:lift(.125)}),0),track(image('pq',.6),1)]};
      lifted.items=lifted.tracks.flatMap(t=>t.items);
      useCompositionsStore.getState().setCompositions([nested,lifted]);
      const brightNumerator=graphic.map((v,c)=>(v+.125)*.25+linear.pq[c]*.6*.75);
      await render('nested child brightness',comp([track({...instance,compositionId:lifted.id},0)]),background.map((v,c)=>v*(1-alpha*.5)+brightNumerator[c]*.5));
      await render('nested instance brightness preserves coverage',comp([track({...instance,effects:lift(.125)},0)]),background.map((v,c)=>v*(1-alpha*.5)+(numerator[c]+.125*alpha)*.5));
      const contrasted={...nested,id:'contrast-inner',tracks:[track(shape('contrast','#6699cc',.25,{effects:grade(1.5)}),0),track(image('pq',.6),1)]};
      contrasted.items=contrasted.tracks.flatMap(t=>t.items);useCompositionsStore.getState().setCompositions([nested,contrasted]);
      const contrastNumerator=contrast(graphic,1.5).map((v,c)=>v*.25+linear.pq[c]*.6*.75);
      await render('nested child contrast',comp([track({...instance,compositionId:contrasted.id},0)]),background.map((v,c)=>v*(1-alpha*.5)+contrastNumerator[c]*.5));
      await render('nested instance contrast preserves coverage',comp([track({...instance,effects:grade(.75)},0)]),background.map((v,c)=>v*(1-alpha*.5)+((numerator[c]/alpha-.5)*.75+.5)*alpha*.5));
      const exposureInner={...nested,id:'exposure-inner',tracks:[track(shape('exposure-child','#6699cc',.25,{effects:expose(1,.125,2)}),0),track(image('pq',.6),1)]};
      exposureInner.items=exposureInner.tracks.flatMap(t=>t.items);useCompositionsStore.getState().setCompositions([nested,exposureInner]);
      const exposureNumerator=exposed(graphic,1,.125,2).map((v,c)=>v*.25+linear.pq[c]*.6*.75);
      await render('nested child exposure',comp([track({...instance,compositionId:exposureInner.id},0)]),background.map((v,c)=>v*(1-alpha*.5)+exposureNumerator[c]*.5));
      const instanceExposure=exposed(numerator.map(v=>v/alpha),-1,-.125,.75);
      await render('nested instance exposure preserves coverage',comp([track({...instance,effects:expose(-1,-.125,.75)},0)]),background.map((v,c)=>v*(1-alpha*.5)+instanceExposure[c]*alpha*.5));
      const saturationInner={...nested,id:'saturation-inner',tracks:[track(shape('saturation-child','#6699cc',.25,{effects:saturate(1.5)}),0),track(image('pq',.6),1)]};
      saturationInner.items=saturationInner.tracks.flatMap(t=>t.items);useCompositionsStore.getState().setCompositions([nested,saturationInner]);
      const saturationNumerator=saturated(graphic,1.5).map((v,c)=>v*.25+linear.pq[c]*.6*.75);
      await render('nested child saturation',comp([track({...instance,compositionId:saturationInner.id},0)]),background.map((v,c)=>v*(1-alpha*.5)+saturationNumerator[c]*.5));
      const instanceSaturation=saturated(numerator.map(v=>v/alpha),1.5);
      await render('nested instance saturation preserves coverage',comp([track({...instance,effects:saturate(1.5)},0)]),background.map((v,c)=>v*(1-alpha*.5)+instanceSaturation[c]*alpha*.5));
      const rasterInner={...nested,id:'saturation-raster-inner',tracks:[track({...image('reconstructed-0',.6),effects:saturate(1.5)},0)]};
      rasterInner.items=rasterInner.tracks.flatMap(t=>t.items);useCompositionsStore.getState().setCompositions([rasterInner]);
      await render('nested reconstructed linear saturation with alpha',comp([track({...instance,compositionId:rasterInner.id},0)]),over(background,saturated(reconstructed['reconstructed-0'],1.5),.15));
      const matte=shape('nested-mask','#ffffff',.5,{isMask:true,maskType:'alpha'});
      const masked={...nested,id:'linear-masked-inner',tracks:[track(matte,0),...children.map(t=>({...t,order:t.order+1}))],items:[matte,...nested.items]};
      useCompositionsStore.getState().setCompositions([masked]);
      const coverage=128/255;
      // Track-scoped masks affect each child before its source-over operation.
      const maskedAlpha=.25*coverage+.6*coverage*(1-.25*coverage);
      const maskedNumerator=graphic.map((v,c)=>v*.25*coverage+linear.pq[c]*.6*coverage*(1-.25*coverage));
      const maskedWant=background.map((v,c)=>v*(1-maskedAlpha*.5)+maskedNumerator[c]*.5);
      await render('nested mask preserves linear straight RGB',comp([track({...instance,compositionId:masked.id},0)]),maskedWant);
      for(const id of ['grayscale','sepia','invert'])await render(`${id} masked nested instance`,comp([track({...instance,compositionId:masked.id,effects:affineEffects(id)},0)]),over(background,affine(id,maskedNumerator.map(v=>v/maskedAlpha)),maskedAlpha*.5));
      await render('temperature on masked nested instance preserves coverage',comp([track({...instance,compositionId:masked.id,effects:temperature(1,-1)},0)]),over(background,tempered(maskedNumerator.map(v=>v/maskedAlpha),1,-1),maskedAlpha*.5));

    } finally {useCompositionsStore.getState().setCompositions(previous);}
    const { CanvasPool } = await import('/src/features/export/utils/canvas-pool.ts');
    const { GpuTexturePool } = await import('/src/infrastructure/gpu-compositor/gpu-texture-pool.ts');
    const pools={canvas:new Set(),texture:new Set()};
    const acquireCanvas=CanvasPool.prototype.acquire, acquireTexture=GpuTexturePool.prototype.acquire;
    CanvasPool.prototype.acquire=function(...args){pools.canvas.add(this);return acquireCanvas.apply(this,args);};
    GpuTexturePool.prototype.acquire=function(...args){pools.texture.add(this);return acquireTexture.apply(this,args);};
    const poolUsage=()=>Object.fromEntries(Object.entries(pools).map(([kind,entries])=>[kind,[...entries].reduce((sum,pool)=>sum+pool.getStats().inUse,0)]));
    const SIZE=64,FPS=30;
    const pumpTrack=(id,order,items)=>({id,name:id,height:60,locked:false,visible:true,muted:false,solo:false,order,items});
    const pumpCanvas=new OffscreenCanvas(SIZE,SIZE);
    const maskedItem={...image('pq',1),transform:{x:0,y:0,width:SIZE,height:SIZE,rotation:0,opacity:1}};
    const mask={...shape('pump-mask','#ffffff',1,{isMask:true,maskType:'alpha'}),transform:{x:0,y:-SIZE/4,width:SIZE,height:SIZE/2,rotation:0,opacity:1}};
    const renderer=await createCompositionRenderer({...comp([]),width:SIZE,height:SIZE,tracks:[track(mask,0),track(maskedItem,1)]},pumpCanvas,pumpCanvas.getContext('2d'),{mode:'export',hdrRasters:hdrInputs});
    let maskUploadPreview;
    const copyExternal=device.queue.copyExternalImageToTexture;
    try {
      for(const target of ['pq','hlg']) {
        const frame=await renderer.renderFrameSignal(30,target);
        record(`masked HDR raster ${target} covered`,sample(Array.from(frame.rgba),SIZE,32,16),deliver(linear.pq,target));
        record(`masked HDR raster ${target} uncovered`,sample(Array.from(frame.rgba),SIZE,32,48),deliver(background,target));
      }
            const entry = await fetch('/src/main.tsx').then((response) => response.text());
            const reactUrl = entry.match(/from "([^"]+\/react\.js\?[^"]*)"/)[1];
            const clientUrl = entry.match(/from "([^"]+\/react-dom_client\.js\?[^"]*)"/)[1];
            const reactModule = await import(reactUrl);
            const React = reactModule.default ?? reactModule;
            const clientModule = await import(clientUrl);
            const { createRoot } = clientModule.default ?? clientModule;
            const { PreviewStage } = await import('/src/features/preview/components/preview-stage.tsx');
            const { usePreviewRuntimeRefs } = await import('/src/features/preview/hooks/use-preview-runtime-refs.ts');
            const { usePreviewOverlayController } = await import('/src/features/preview/hooks/use-preview-overlay-controller.ts');
            const { usePreviewRenderPump } = await import('/src/features/preview/hooks/use-preview-render-pump-controller.ts');
            const { usePlaybackStore } = await import('/src/shared/state/playback/index.ts');
            const { usePreviewBridgeStore } = await import('/src/shared/state/preview-bridge/index.ts');
            const { resetPlaybackPreviewState } = await import('/src/shared/state/playback-preview-test-helpers.ts');
            const host = document.createElement('div');
            document.body.append(host);
            const root = createRoot(host);
            const noop = () => {}, no = () => false, nothing = () => null;
            const calls = [], failures = [];
            const managedRenderer = { ...renderer, renderFrame: async (frame) => {
              calls.push(frame);
              try { await renderer.renderFrame(frame); }
              catch (error) { failures.push({ frame, name: error.name, reason: error.message }); throw error; }
            } };
            const props = { fps: FPS, width: SIZE, height: SIZE, durationInFrames: 60,
              backgroundColor: '#000000', transitions: [], keyframes: [], tracks: [pumpTrack('player-sdr', 0,
                [{ id: 'decoded-sdr', type: 'video', trackId: 'player-sdr', src: '/hdr-fixture/pq.mp4',
                  from: 20, durationInFrames: 30, sourceStart: 0, sourceEnd: 30, sourceFps: FPS,
                  sourceDuration: 30, speed: 1, transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } }])] };
            function Harness() {
              const refs = usePreviewRuntimeRefs();
              const overlay = usePreviewOverlayController({ bypassPreviewSeekRef: refs.bypassPreviewSeekRef,
                setDisplayedFrame: usePreviewBridgeStore.getState().setDisplayedFrame });
              const params = React.useMemo(() => ({ ...refs.renderPumpRefs, fps: FPS,
                forceFastScrubOverlay: true, useProxy: false, combinedTracks: [],
                fastScrubBoundaryFrames: [], fastScrubBoundarySources: [], playbackTransitionOverlayWindows: [],
                playbackTransitionLookaheadFrames: 0, playbackTransitionCooldownFrames: 0,
                playbackTransitionPrerenderRunwayFrames: 0, previewPerfRef: { current: {} },
                ensureFastScrubRenderer: async () => { refs.scrubOffscreenCanvasRef.current = pumpCanvas; return managedRenderer; },
                ensureBgTransitionRenderer: async () => null, disposeFastScrubRenderer: noop,
                shouldPreferPlayerForPreview: no, shouldPreserveHighFidelityBackwardPreview: no,
                getTransitionWindowByStartFrame: nothing, getTransitionWindowForFrame: nothing,
                getPlayingAnyTransitionPrewarmStartFrame: nothing, getPausedTransitionPrewarmStartFrame: nothing,
                getPinnedTransitionElementForItem: nothing, pinTransitionPlaybackSession: nothing,
                clearTransitionPlaybackSession: noop, cacheTransitionSessionFrame: noop,
                preparePlaybackTransitionFrame: async () => false, pushTransitionTrace: noop,
                isPausedTransitionOverlayActive: no, trackPlayerSeek: noop,
                setDisplayedFrame: usePreviewBridgeStore.getState().setDisplayedFrame,
                hideFastScrubOverlay: overlay.hideFastScrubOverlay, hidePlaybackTransitionOverlay: overlay.hidePlaybackTransitionOverlay,
                showFastScrubOverlayForFrame: overlay.showFastScrubOverlayForFrame,
                showPlaybackTransitionOverlayForFrame: overlay.showPlaybackTransitionOverlayForFrame,
                showFastScrubOverlayRef: overlay.showFastScrubOverlayRef }), [refs.renderPumpRefs]);
              const unavailable = usePreviewRenderPump(params);
              return React.createElement(PreviewStage, { backgroundRef: { current: null }, playerRef: refs.playerRef,
                scrubCanvasRef: refs.scrubCanvasRef, gpuEffectsCanvasRef: refs.gpuEffectsCanvasRef,
                needsOverflow: false, playerSize: { width: SIZE, height: SIZE }, playerRenderSize: { width: SIZE, height: SIZE },
                overlayRenderSize: { width: SIZE, height: SIZE }, totalFrames: 60, fps: FPS, initialFrame: 30,
                isResolving: false, isRenderedOverlayVisible: overlay.isRenderedOverlayVisible,
                hdrPreviewUnavailable: unavailable, colorGradeComparisonMode: 'split', inputProps: props,
                onBackgroundClick: noop, onFrameChange: noop, onPlayStateChange: noop, setPlayerContainerRefCallback: noop });
            }
            const waitUntil = async (ready) => {
              const deadline = performance.now() + 10000;
              while (!ready()) {
                if (performance.now() > deadline) throw new Error('Mask preview regression timed out');
                await new Promise(requestAnimationFrame);
              }
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
            };
            const state = () => {
              const player = host.querySelector('[data-player-container] [data-player-container]');
              if (!player) throw new Error('Production Player surface missing');
              return { playerVisibility: getComputedStyle(player).visibility,
                unavailable: Boolean(host.querySelector('[role="alert"]')),
                displayedFrame: usePreviewBridgeStore.getState().displayedFrame };
            };
            const beforePreview = poolUsage();
            resetPlaybackPreviewState(30);
            device.queue.copyExternalImageToTexture = () => { throw new Error('forced mask upload failure'); };
            try {
              root.render(React.createElement(Harness));
              await waitUntil(() => failures.length > 0);
              const first = state();
              maskUploadPreview = { first, calls, failures, before: beforePreview };
              if (failures[0].name === 'HdrRenderUnavailableError') {
                const firstFailures = failures.length;
                usePlaybackStore.getState().setPreviewFrame(31);
                await waitUntil(() => failures.length > firstFailures && failures.some((error) => error.frame === 31));
                maskUploadPreview.seek = state();
                maskUploadPreview.afterRefusals = poolUsage();
                device.queue.copyExternalImageToTexture = copyExternal;
                usePlaybackStore.getState().setPreviewFrame(32);
                await waitUntil(() => usePreviewBridgeStore.getState().displayedFrame === 32);
                maskUploadPreview.recovery = state();
              }
            } finally {
              device.queue.copyExternalImageToTexture = copyExternal;
              root.unmount(); host.remove(); resetPlaybackPreviewState();
            }

      maskUploadPreview.after=poolUsage();
    }finally{renderer.dispose();CanvasPool.prototype.acquire=acquireCanvas;GpuTexturePool.prototype.acquire=acquireTexture;}
    const refusals=[];
    const fx=[{id:'fx',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-levels',params:{inputBlack:0,inputWhite:1,gamma:1,outputBlack:0,outputWhite:1}}}];
    CanvasPool.prototype.acquire=function(...args){pools.canvas.add(this);return acquireCanvas.apply(this,args);};
    GpuTexturePool.prototype.acquire=function(...args){pools.texture.add(this);return acquireTexture.apply(this,args);};
    const gatedCompositions=[
      ['mixed contrast and levels',comp([track(shape('mixed-contrast','#ffffff',1,{effects:[...grade(1.5),...fx]}),0)])],
      ['mixed brightness and levels',comp([track(shape('mixed','#ffffff',1,{effects:[...lift(.125),...fx]}),0)])],
      ['mixed saturation and levels',comp([track(shape('mixed-saturation','#ffffff',1,{effects:[...saturate(1.5),...fx]}),0)])],
      ['mixed exposure and levels',comp([track(shape('mixed-exposure','#ffffff',1,{effects:[...expose(1,.125,2),...fx]}),0)])],
      ['effect',comp([track(shape('effect','#ffffff',1,{effects:fx}),0)])],
      ['blend',comp([track(shape('blend','#ffffff',.5,{blendMode:'screen'}),0)])],
      ['transition',{...comp([track(image('pq',1),0)]),tracks:[{...track(image('pq',1),0),items:[{...image('pq',1),durationInFrames:30},{...image('hlg',1),from:30,trackId:'pq'}]}],transitions:[{id:'cut',type:'crossfade',presentation:'dissolve',timing:'linear',trackId:'pq',leftClipId:'pq',rightClipId:'hlg',durationInFrames:20,alignment:.5}]}],
    ];
    const refuseComposition=async(name,composition,frame)=>{
      const c=new OffscreenCanvas(16,16);const renderer=await createCompositionRenderer(composition,c,c.getContext('2d'),{mode:'export',hdrRasters:hdrInputs});
      const before=poolUsage();
      try {let error;try{await renderer.renderFrameSignal(frame,'pq');}catch(e){error={name:e.name,message:e.message};}refusals.push({name,error,before,after:poolUsage()});}
      finally{renderer.dispose();}
    };
    const savedCompositions=useCompositionsStore.getState().compositions;
    try {
      for(const [name,composition] of gatedCompositions) {
        await refuseComposition(name,composition,name==='transition'?30:0);
        const nested={...composition,id:`gated-${name}`,name:`gated-${name}`,items:composition.tracks.flatMap(t=>t.items)};
        useCompositionsStore.getState().setCompositions([nested]);
        const instance={id:`gated-instance-${name}`,type:'composition',compositionId:nested.id,compositionWidth:16,compositionHeight:16,trackId:'instance',from:0,durationInFrames:60,transform:{x:0,y:0,width:16,height:16,rotation:0,opacity:1}};
        // The nested transition ceiling is intentionally the whole instance.
        await refuseComposition(`nested ${name}`,comp([track(instance,0)]),0);
        if(name==='transition') {
          // Top-level additive is supported, but the nested transition ceiling remains.
          useCompositionsStore.getState().setCompositions([{...nested,transitions:nested.transitions.map(t=>({...t,presentation:'additiveDissolve'}))}]);
          await refuseComposition('nested additive transition',comp([track(instance,0)]),0);
        }
      }
    }finally{useCompositionsStore.getState().setCompositions(savedCompositions);CanvasPool.prototype.acquire=acquireCanvas;GpuTexturePool.prototype.acquire=acquireTexture;}

    const {GPU_EFFECT_REGISTRY,getGpuEffectDefaultParams}=await import('/src/infrastructure/gpu-effects/index.ts');
    const {GPU_TRANSITION_REGISTRY}=await import('/src/infrastructure/gpu-transitions/registry.ts');
    const {TransitionPipeline}=await import('/src/infrastructure/gpu-transitions/transition-pipeline.ts');
    const {BLEND_MODE_INDEX}=await import('/src/types/blend-modes.ts');
    const transition=TransitionPipeline.create(device);if(!transition)throw new Error('Transition pipeline unavailable');transition.setWorkingRange('hdr');
    const gateInput=makeTex(2,2),gateOutput=makeTex(2,2),gateRight=makeTex(2,2);
    const additive={buffersCreated:0,buffersDestroyed:0,before:poolUsage()};
    const readAdditive=async()=>{
      const buffer=device.createBuffer({size:512,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});additive.buffersCreated++;
      try {
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:gateOutput},{buffer,bytesPerRow:256},[2,2]);device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);return Array.from(new Float16Array(buffer.getMappedRange(),0,4));
      }finally{buffer.destroy();additive.buffersDestroyed++;}
    };
    const uploadGate=(texture,rgba)=>device.queue.writeTexture({texture},new Float16Array(Array.from({length:4},()=>rgba).flat()),{bytesPerRow:16},[2,2]);
    const renderAdditive=async(name,left,right,progress,want,inputAlpha='straight',budget=.004)=>{
      uploadGate(gateInput,left);uploadGate(gateRight,right);
      if(!transition.renderTexturesToTexture('additiveDissolve',gateInput,gateRight,gateOutput,progress,2,2,undefined,undefined,inputAlpha,'straight'))throw new Error(`${name} additive float route rejected`);
      record(name,await readAdditive(),want,budget);
    };
    const refuse=(name,run)=>{let error;try{run();}catch(e){error={name:e.name,message:e.message};}refusals.push({name,error});};
    try {
      const brightness=[{id:'brightness',type:'gpu-brightness',name:'brightness',enabled:true,params:{amount:.125}}];
      const contrastEffects=[{id:'contrast',type:'gpu-contrast',name:'contrast',enabled:true,params:{amount:1.5}}];
      const exposureEffects=[{id:'exposure',type:'gpu-exposure',name:'exposure',enabled:true,params:{exposure:1,offset:.125,gamma:2}}];
      const saturationEffects=[{id:'saturation',type:'gpu-saturation',name:'saturation',enabled:true,params:{amount:1.5}}];
      const legacyVideo=document.createElement('video');
      const temperatureEffects=[{id:'temperature',type:'gpu-temperature',name:'temperature',enabled:true,params:{temperature:1,tint:-1}}];
      refuse('HDR legacy canvas temperature',()=>gpu.effects.applyEffectsToCanvas(canvas,temperatureEffects));
      refuse('HDR legacy video temperature',()=>gpu.effects.applyEffectsToVideoTexture(legacyVideo,temperatureEffects,{x:0,y:0,width:2,height:2},2,2,gateOutput));
      refuse('HDR temperature plus unmigrated levels',()=>gpu.effects.applyTextureEffectsToTexture(gateInput,[...temperatureEffects,{...temperatureEffects[0],type:'gpu-levels',params:{}}],gateOutput,2,2));
      refuse('HDR legacy canvas saturation',()=>gpu.effects.applyEffectsToCanvas(canvas,saturationEffects));
      refuse('HDR legacy video saturation',()=>gpu.effects.applyEffectsToVideoTexture(legacyVideo,saturationEffects,{x:0,y:0,width:2,height:2},2,2,gateOutput));
      refuse('HDR legacy canvas exposure',()=>gpu.effects.applyEffectsToCanvas(canvas,exposureEffects));
      refuse('HDR legacy video exposure',()=>gpu.effects.applyEffectsToVideoTexture(legacyVideo,exposureEffects,{x:0,y:0,width:2,height:2},2,2,gateOutput));
      refuse('HDR legacy canvas contrast',()=>gpu.effects.applyEffectsToCanvas(canvas,contrastEffects));
      refuse('HDR legacy video contrast',()=>gpu.effects.applyEffectsToVideoTexture(legacyVideo,contrastEffects,{x:0,y:0,width:2,height:2},2,2,gateOutput));
      refuse('HDR legacy canvas brightness',()=>gpu.effects.applyEffectsToCanvas(canvas,brightness));
      refuse('HDR legacy video canvas brightness',()=>gpu.effects.applyEffectsToVideo(legacyVideo,brightness,{x:0,y:0,width:2,height:2},2,2));
      refuse('HDR legacy video texture brightness',()=>gpu.effects.applyEffectsToVideoTexture(legacyVideo,brightness,{x:0,y:0,width:2,height:2},2,2,gateOutput));
      const encodedOutput=device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST});
      try {
        refuse('HDR brightness encoded output',()=>gpu.effects.applyTextureEffectsToTexture(gateInput,brightness,encodedOutput,2,2));
        refuse('HDR saturation encoded output',()=>gpu.effects.applyTextureEffectsToTexture(gateInput,saturationEffects,encodedOutput,2,2));
        refuse('HDR temperature encoded output',()=>gpu.effects.applyTextureEffectsToTexture(gateInput,temperatureEffects,encodedOutput,2,2));
        refuse('HDR exposure encoded output',()=>gpu.effects.applyTextureEffectsToTexture(gateInput,exposureEffects,encodedOutput,2,2));
      }
      finally { encodedOutput.destroy(); }
      refuse('HDR brightness plus unknown effect',()=>gpu.effects.applyTextureEffectsToTexture(gateInput,[...brightness,{...brightness[0],type:'gpu-not-an-effect'}],gateOutput,2,2));
      for(const id of [...GPU_EFFECT_REGISTRY.keys()].filter(id=>!['gpu-brightness','gpu-contrast','gpu-exposure','gpu-saturation','gpu-temperature','gpu-vibrance','gpu-grayscale','gpu-sepia','gpu-invert','gpu-box-blur','gpu-gaussian-blur','gpu-motion-blur','gpu-pixelate','gpu-twirl','gpu-wave','gpu-bulge'].includes(id)))refuse(`effect ${id}`,()=>gpu.effects.applyTextureEffectsToTexture(gateInput,[{id,type:id,name:id,enabled:true,params:getGpuEffectDefaultParams(id)}],gateOutput));
      // Additive has dedicated linear light semantics; every other registry entry
      // must retain its typed refusal. The oracle is independent of production WGSL.
      device.pushErrorScope('validation');
      try {
        const left=[2,-.5,.25,.5],right=[-.25,3,-1,.25];
        for(const progress of [0,.5,1]) {
          const alpha=left[3]*(1-progress)+right[3]*progress;
          const want=progress===0?left:progress===1?right:left.slice(0,3).map((v,c)=>
            (v*left[3]*(1-progress)+right[c]*right[3]*progress+(v*left[3]+right[c]*right[3])*.22*Math.sin(Math.PI*progress))/alpha).concat(alpha);
          await renderAdditive(`additive linear float @${progress}`,left,right,progress,want);
        }
        await renderAdditive('additive premultiplied alpha',[1,-.25,.125,.5],[0,0,0,0],.5,[2.88,-.72,.36,.25],'premultiplied');
        for(const progress of [0,.5,1])await renderAdditive(`additive hidden zero coverage @${progress}`,[100,-100,20,0],[-100,100,-20,0],progress,[0,0,0,0],'straight',0);
        await renderAdditive('additive reference white flash',[1,1,1,1],[1,1,1,1],.5,[1.44,1.44,1.44,1]);
        record('additive flash through managed PQ output',sample(await read(gateOutput),2,0),deliver([1.44,1.44,1.44],'pq'));
        additive.cachedInputsBeforeDestroy=transition.premultipliedInputs.length;
        additive.uniformBuffersBeforeDestroy=transition.uniformBuffers.size;
      }finally{const error=await device.popErrorScope();if(error)throw new Error(`Additive GPU validation failed: ${error.message}`);}
      const legacyLeft=new OffscreenCanvas(2,2),legacyRight=new OffscreenCanvas(2,2);
      refuse('additive HDR Canvas input',()=>transition.render('additiveDissolve',legacyLeft,legacyRight,.5,2,2));
      const encodedTransition=device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});
      try{refuse('additive HDR encoded output',()=>transition.renderTexturesToTexture('additiveDissolve',gateInput,gateRight,encodedTransition,.5,2,2));}
      finally{encodedTransition.destroy();}
      for(const id of GPU_TRANSITION_REGISTRY.keys())if(id!=='additiveDissolve')refuse(`transition ${id}`,()=>transition.renderTexturesToTexture(id,gateInput,gateInput,gateOutput,.5,2,2));
      for(const mode of Object.keys(BLEND_MODE_INDEX).filter(id=>id!=='normal'))refuse(`blend ${mode}`,()=>gpu.mediaBlend.blend(gateInput,gateInput,gateOutput,mode));
    }finally{
      gateInput.destroy();gateRight.destroy();gateOutput.destroy();transition.destroy();
      additive.after=poolUsage();additive.cachedInputsAfterDestroy=transition.premultipliedInputs.length;
      additive.uniformBuffersAfterDestroy=transition.uniformBuffers.size;
      additive.pipelineRetained=transition.has('additiveDissolve');
    }
    output.destroy();gpu.dispose();return {rows,refusals,linear,maskUploadPreview,additive};
  });
  assert.deepEqual(await testedSource(new URL(import.meta.url)),source,'tested inputs changed during measurement');
  report.source=source;
  if(process.env.LINEAR_HDR_REPORT)await writeFile(process.env.LINEAR_HDR_REPORT,JSON.stringify(report));
  for(const row of report.rows)row.want.forEach((v,c)=>assert.ok(Number.isFinite(row.got[c])&&Math.abs(row.got[c]-v)<=row.budget,`${row.name} channel ${c}: ${row.got[c]} != ${v}`));
  for(const row of report.refusals) {
    assert.equal(row.error?.name,'HdrRenderUnavailableError',`${row.name} must refuse through the managed HDR type`);
    if(row.before) {assert.deepEqual(row.before,{canvas:0,texture:0});assert.deepEqual(row.after,row.before,`${row.name} retained pooled resources`);}
  }
  assert.equal(report.additive.buffersCreated,8);assert.equal(report.additive.buffersDestroyed,report.additive.buffersCreated);
  assert.equal(report.additive.cachedInputsBeforeDestroy,2);assert(report.additive.uniformBuffersBeforeDestroy>0);
  assert.equal(report.additive.cachedInputsAfterDestroy,0);assert.equal(report.additive.uniformBuffersAfterDestroy,0);assert.equal(report.additive.pipelineRetained,false);
  assert.deepEqual(report.additive.before,{canvas:0,texture:0});assert.deepEqual(report.additive.after,report.additive.before);
  const preview=report.maskUploadPreview;
  for(const state of [preview.first,preview.seek]) {assert.equal(state.playerVisibility,'hidden');assert.equal(state.unavailable,true);}
  assert.deepEqual(preview.recovery,{playerVisibility:'visible',unavailable:false,displayedFrame:32});
  assert(preview.failures.some(e=>e.frame===30)&&preview.failures.some(e=>e.frame===31));
  assert(preview.failures.every(e=>e.name==='HdrRenderUnavailableError'));
  for(const usage of [preview.before,preview.afterRefusals,preview.after])assert.deepEqual(usage,{canvas:0,texture:0});
  assert(Math.max(...report.linear.pq)>1&&Math.min(...report.linear.pq)<0,'fixture must test signed HDR');
  console.log(JSON.stringify({check:'linear display-light HDR subtree',comparisons:report.rows.reduce((sum,row)=>sum+row.want.length,0),typedRefusals:report.refusals.length}));
}finally{await browser.close();}
