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
    binding.browser === '148.0.7778.96' &&
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
          '5b29142999ca0f06d8d9f151ad0bfeae95b6b75892b70c38a9532b2152de32ec'),
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
