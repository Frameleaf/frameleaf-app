// Independent base-only fragment raster witness; no effect/sampler imports.
export async function probeBaseRaster(device, width, height, production) {
  const independent = `struct VertexOutput { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) @interpolate(flat) tri:u32 };
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->VertexOutput {
 let corners=array<vec2f,6>(vec2f(0.,1.),vec2f(1.,1.),vec2f(0.,0.),vec2f(0.,0.),vec2f(1.,1.),vec2f(1.,0.));
 let uv=corners[i]; var result:VertexOutput;result.position=vec4f(2.*uv.x-1.,1.-2.*uv.y,0.,1.);result.uv=uv;result.tri=i/3u;return result;
}`

  const rows = []
  for (const [W, H] of [[width, height]]) {
    const states = {
      dimensions: [W, H],
      viewport: [0, 0, W, H, 0, 1],
      scissor: [0, 0, W, H],
      sampleCount: 1,
      sampleMask: 4294967295,
      topology: 'triangle-list',
      drawVertices: 6,
      alphaToCoverageEnabled: false,
    }
    const results = []
    for (const kind of ['independent', 'production', 'productionTriangle']) {
      let vertex = !['production', 'productionTriangle'].includes(kind) ? independent : production
      if (kind === 'productionTriangle')
        vertex = vertex
          .replace(
            '@location(0) uv: vec2f,',
            '@location(0) uv: vec2f,\n@location(1) @interpolate(flat) tri:u32,',
          )
          .replace(
            'output.uv = uvs[vertexIndex];',
            'output.uv = uvs[vertexIndex];\noutput.tri=vertexIndex/3u;',
          )

      const actualState = states
      const fragment = `@group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
 @fragment fn fragmentMain(input:VertexOutput)->@location(0) vec4f {let x=u32(input.position.x);let y=u32(input.position.y);let pixel=y*${W}u+x;output[pixel*2u]=vec4f(input.uv,input.position.xy);output[pixel*2u+1u]=vec4f(f32(pixel),${kind === 'production' ? '99.0' : 'f32(input.tri)'},${W}.0,${H}.0);return vec4f(0.,0.,0.,1.);}`
      const buffer = device.createBuffer({
        size: W * H * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      })
      const read = device.createBuffer({
        size: W * H * 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const texture = device.createTexture({
        size: [W, H],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      try {
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: vertex + fragment })
        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertexMain' },
          fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
          multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
        })
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer } }],
        })
        const enc = device.createCommandEncoder()
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: texture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        pass.setViewport(...actualState.viewport)
        pass.setScissorRect(...actualState.scissor)
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.draw(6)
        pass.end()
        enc.copyBufferToBuffer(buffer, 0, read, 0, W * H * 32)
        device.queue.submit([enc.finish()])
        const error = await device.popErrorScope()
        if (error) throw Error(error.message)
        await read.mapAsync(GPUMapMode.READ)
        const mapped = read.getMappedRange()
        results.push({
          kind,
          state: actualState,
          values: Array.from(new Float32Array(mapped)),
          bits: Array.from(new Uint32Array(mapped)),
          shader: vertex + fragment,
        })
        read.unmap()
      } finally {
        buffer.destroy()
        read.destroy()
        texture.destroy()
      }
    }
    rows.push({ states, results })
  }
  const info = { vendor: device.adapterInfo.vendor, architecture: device.adapterInfo.architecture }
  return { adapter: info, rows }
}

export function validateBaseRaster(capture, envelope, binding) {
  const check = (condition, label) => {
    if (!condition) throw Error('RASTER_' + label)
  }
  check(
    (binding.browser === '148.0.7778.96' &&
      (binding.sourceSha256 ===
        'e38c2512b0ac3b16f37488192687977440f0e083bac4e4456b71e0adf5c00689' ||
        binding.sourceSha256 ===
          '614abe7d7fb4b1b17442b32dbab1f90e31c9297bf4c6657a2fa9bec3a9c3e711' ||
        binding.sourceSha256 ===
          'a90bde5db2117561f3cbce4e23e7b118660741eb7adb6a39ea12eb5bbeab559f' ||
        binding.sourceSha256 ===
          '01983a71b49ed5721ed9692b6bfd92b3122c651b7f48d1a5c7e675007f410156' ||
        binding.sourceSha256 ===
          '5615c48d57f39c36dbdf19754bca16813990fb47060832b1394f1be9e97ac6ad' ||
        binding.sourceSha256 ===
          '680d0070383b0b7d5721a9cd874325abc19b3d635490b90d0f0d90b72b67d5c0' ||
        binding.sourceSha256 ===
          'c212cc40fde85a70a9054489b2da1a15dec75cea6bd9e9333230875d68a2d470' ||
        binding.sourceSha256 ===
          '6a94f497df2b949fe43059094ed7cdaff656b06dd47422021fc55b079c7f7889' ||
        binding.sourceSha256 ===
          '86795b1fd91eca8d7804ce35c00930b36f507d6675287ffce9d621ac5c28b959' ||
        binding.sourceSha256 ===
          '7c83bc88923abb5e8995544567d437d260461569ef5dfaf14b893a4d664d9481' ||
        binding.sourceSha256 ===
          '5b29142999ca0f06d8d9f151ad0bfeae95b6b75892b70c38a9532b2152de32ec' ||
        binding.sourceSha256 ===
          'e7e93f672603b71a38a9500439ae7e44353405f4ddc707482bf539f87d5b9f8d' ||
        binding.sourceSha256 ===
          '38fe01f4393ad7c6c10462fbb03fffc545215e9da745e5d37f9f15a70fcaa904' ||
        binding.sourceSha256 ===
          '723f55c7faae8dc989406bbf7df7a1f795ef1d2053b17379fb71beb87005fcca' ||
        binding.sourceSha256 ===
          '6718da5bc961bc4ad4eb5a96f4e4d158bfce331fc8087f16729a09da1ac0e4a3' ||
        binding.sourceSha256 ===
          '19daa0b620454002022c6eac56b13537c232fe5270104021e5c9c6b63f884c4c' ||
        binding.sourceSha256 ===
          'cb8c9b6ec30597c44a26cead6dc11fba3770870192b156c68c8ddfe7e032a54f' ||
        binding.sourceSha256 ===
          '85ef9a025dba470a1cb73d0a1ee6616a0e8d428602567fe7d9930959215dd302' ||
        binding.sourceSha256 ===
          '2f020b4240175b0ee7e4d75110582b0015c981171761d1021a15fce38b98418e' ||
        binding.sourceSha256 ===
          '6d1edf68bb2d67195f3cfa5a58b78fe1c36148069934efef3060962d199e645d' ||
        binding.sourceSha256 ===
          '1a5fb80a4729b569646bc258c4815fbcabd79d0bc13f0910ad0cdc43ce29ed7e' ||
        binding.sourceSha256 ===
          'f0fb723b695efa8d1ea5af4a9ab5e7523f112f6bad76a582ae964e02152e65d9' ||
        binding.sourceSha256 ===
          '365ce48c4403f764bb77fee14b78fd0b154dd7906106748ee5790e0c3b8af424' ||
        binding.sourceSha256 ===
          '1d91e981316146386b98192d087f140b9752e391476a8805a1bce302c546bdee' ||
        binding.sourceSha256 ===
          '86c3c5b8cab095d45df4c18601185de27b9f3a5b5ca64dc393f2b80c54e3a07d' ||
        binding.sourceSha256 ===
          '2be3c9aace8167be04a94878541a2fb5cb874d69274e9b05465596801a6d95e9' ||
        binding.sourceSha256 ===
          '2c892d4445da5b1e390a9505a82d34ac402cbef5e6bd2f1f88d532aa61e0d6f7' ||
        binding.sourceSha256 ===
          'fbff0121cec558d07244fa17d2959b148a5ac2c840ae3b7185c7f5ca9809c578' ||
        binding.sourceSha256 ===
          '1acc086ce7d5ae97e50f010b7de4c8f540af195c506fb73573e66aacbad9ae80' ||
        binding.sourceSha256 ===
          '3aed97c3a3e98844f1d742d1d53acc6094a6b92e478c4db1bd27ac972c7a66ce' ||
        binding.sourceSha256 ===
          'de67658c3f4c3eb30aaa5afdcea62c79993d8375c1923931a9dd36316b550db6' ||
        binding.sourceSha256 ===
          'e2821a958f1da55ac5f03b641b9e2f18fe82d0e283ef63e5149cb1b31045215b' ||
        binding.sourceSha256 ===
          '11c977ef51aaf616ae0a0e7be1ff1ecf33ba0ebac8e155d3fc2e2454223a5a0d')) ||
      (binding.browser === '156.0.8078.4' &&
        (binding.sourceSha256 ===
          'f4fce3ae0293ca9ab3587ef12e014d384ef6b0aa4d043e3f4b3492402014d20c' ||
          binding.sourceSha256 ===
            '0c69a72edaca2861c5d4fad86b6b3e4ba9bb088bb65ffceace32d7b046fa5164' ||
          binding.sourceSha256 ===
            'e3f7e88e3e38e6ace377a230b47ec41f9197db373cbb5932024dd94b9b67c7e9' ||
          // FL-450 locked-lane drag refusal changes timeline UI only, not the raster producers.
          binding.sourceSha256 ===
            '804a204a22f3f9bb43dce373782c83fd2f2ffeebcd24934568663c844c73d0e6' ||
          // The audio-only repair retains the same raster producers and Chromium version.
          binding.sourceSha256 ===
            'dc17859f6f1646565d4072901c0001fd7b27e4a152ede2f2143c5998bcea063a' ||
          // FL-505 Node 22.23.4 pin retains the same raster producers and Chromium version.
          binding.sourceSha256 ===
            '9e607ca9e5b9105c4afdb7029fc1386ebd53a4eecc481ab8e68da08ca3b658cf' ||
          // FL-562 transcript editing changes the transcript panel and timeline edits only.
          binding.sourceSha256 ===
            'd13b629e99bb4d9de6dd5e884398fffa2e096d01ce74c225ccbf6f4771b2e79b' ||
          // FL-598 loudness matching changes clip volume, the audio panel and the export report only.
          binding.sourceSha256 ===
            '327c62cd069175122e4ea2d9f9a3ecfbe4d2c24abfc810ab1f454b18d58112bf' ||
          // FL-598 loudness match: binding covers link state
          binding.sourceSha256 ===
            'b495ed300792bca77afbe20775ec504026025ec2113d15dc0a2d27d87db80d6d' ||
          // FL-598 loudness: layout-specific channel weights
          binding.sourceSha256 ===
            '7423283e576bff16bdc54221cff8d87bd7b3bb26dc3e516b635e12dce3f3bd72')),
    'SOURCE_BROWSER',
  )
  check(
    envelope.receipts.every((r) => r.quadSha256 === binding.quadSha256),
    'QUAD',
  )
  const adapter = capture.adapter
  const backend =
    adapter.vendor === 'google' && adapter.architecture === 'swiftshader'
      ? 'swift'
      : adapter.vendor === 'apple' && adapter.architecture === 'metal-3'
        ? 'metal'
        : null
  check(backend !== null, 'BACKEND')
  const args =
    backend === 'swift'
      ? [
          '--enable-unsafe-webgpu',
          '--use-angle=swiftshader',
          '--use-vulkan=swiftshader',
          '--enable-features=Vulkan',
          '--disable-accelerated-2d-canvas',
        ]
      : [
          '--enable-unsafe-webgpu',
          '--enable-features=Vulkan',
          '--ignore-gpu-blocklist',
          '--use-angle=metal',
        ]
  check(JSON.stringify(binding.backendArgs) === JSON.stringify(args), 'BACKEND_ARGS')
  check(capture.rows.length === 1, 'COUNT')
  const row = capture.rows[0],
    [W, H] = row.states.dimensions
  const fixed = envelope.envelopes.find((e) => e.backend === backend && e.W === W && e.H === H)
  check(fixed !== undefined, 'UNKNOWN_DIMENSIONS')
  const expectedState = { ...fixed.state, alphaToCoverageEnabled: false }
  check(JSON.stringify(row.states) === JSON.stringify(expectedState), 'STATE')
  check(row.results.length === 3, 'PIPELINES')
  const bits = (value) => new Uint32Array(new Float32Array([value]).buffer)[0]
  for (const kind of ['independent', 'production', 'productionTriangle']) {
    const r = row.results.find((r) => r.kind === kind)
    check(r !== undefined, 'PIPELINE')
    check(JSON.stringify(r.state) === JSON.stringify(expectedState), 'STATE')
    check(
      r.values.length === W * H * 8 &&
        r.bits.length === r.values.length &&
        r.values.every((v) => Number.isFinite(v) && Math.fround(v) === v),
      'SIZE_FINITE',
    )
    for (const c of fixed.components) {
      const v = r.values[c.pixel * 8 + c.component]
      check(bits(v) === r.bits[c.pixel * 8 + c.component] && v >= c.low && v <= c.high, 'UV')
    }
    for (let i = 0; i < W * H; i++) {
      const x = i % W,
        y = Math.floor(i / W)
      check(
        r.values[i * 8 + 2] === x + 0.5 &&
          r.values[i * 8 + 3] === y + 0.5 &&
          r.values[i * 8 + 4] === i &&
          r.values[i * 8 + 6] === W &&
          r.values[i * 8 + 7] === H,
        'PIXEL',
      )
      if (kind !== 'production')
        check(r.values[i * 8 + 5] === ((2 * y + 1) * W > (2 * x + 1) * H ? 0 : 1), 'TRIANGLE')
    }
  }
  const original = row.results.find((r) => r.kind === 'independent')
  for (const r of row.results)
    for (let i = 0; i < W * H; i++)
      for (let c = 0; c < 4; c++)
        check(r.bits[i * 8 + c] === original.bits[i * 8 + c], 'PRODUCTION_BITS')
  return {
    backend,
    width: W,
    height: H,
    state: expectedState,
    components: fixed.components,
    binding,
  }
}
