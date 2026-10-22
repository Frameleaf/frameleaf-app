ARG CPU_IMAGE=python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-runtime-ubuntu22.04@sha256:4a801ef9232d2b05e69df4eb8aa054dbbe2824e5499e1e6e857320bb01ac41a9
ARG DEVICE=cpu
# FL-408: the bundled Studio render worker. Same Node as the server's Studio engine stage.
ARG STUDIO_NODE_IMAGE=node:22.23.4-bookworm@sha256:2bd396628eceb5c999a6e43731fab69d5fb98b94ba9d9d90b5f64575c5178765
ARG NODE_RUNTIME_IMAGE=node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf

# Native CPU semantic masks use the locked Torch / Torchvision Python 3.12 ABI.
FROM ${CPU_IMAGE} AS builder-cpu

FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS builder-openvino

# Use the same CUDA base in both stages and a portable Python installation.
FROM ${CUDA_IMAGE} AS builder-cuda

COPY --from=ghcr.io/astral-sh/uv:0.13.4@sha256:9f130421e930bfbdc563c00740466603f8723158e90297d07957c2294640262b /uv /bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv python install 3.12.15 && \
    ln -s /opt/python/cpython-3.12.15-linux-$(uname -m)-gnu/bin/python3 /usr/local/bin/python3

FROM python:3.13.16-trixie@sha256:98daa3227dee3c38b8ee9e020e3785ec4274b1affd854c9f40ead46b6fb31f55 AS builder-armnn

# renovate: datasource=github-releases depName=ARM-software/armnn
ARG ARMNN_VERSION="v26.07"

ENV ARMNN_PATH=/opt/armnn
COPY ann /opt/ann
RUN mkdir /opt/armnn && \
    curl -SL "https://github.com/ARM-software/armnn/releases/download/${ARMNN_VERSION}/ArmNN-linux-aarch64.tar.gz" | tar -zx -C /opt/armnn && \
    cd /opt/ann && \
    sh build.sh

FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS builder-rknn

# Warning: 25GiB+ disk space required to pull this image
# TODO: find a way to reduce the image size
FROM rocm/dev-ubuntu-24.04:7.2-complete@sha256:86e11093b4a7ec2a79b1b6701d10e840a6994f21c7e05929b51eb9be361c683a AS builder-rocm

# FL-408: the Studio render worker this image runs by default (FRAMELEAF_STUDIO_WORKER=false turns
# it off). The pinned Studio engine is recovered and verified exactly as the server image does,
# its headless harness is built, and only the worker, the built harness and its three runtime
# packages are kept. Build with the repository as the named context `frameleaf`:
#   docker build --build-context frameleaf=. -f machine-learning/Dockerfile machine-learning
FROM ${STUDIO_NODE_IMAGE} AS studio-worker

RUN npm install --global npm@12.2.0 --ignore-scripts --no-audit --no-fund

WORKDIR /usr/src/app
COPY --from=frameleaf scripts/frameleaf-studio-contracts.mjs scripts/frameleaf-studio-rights.mjs ./scripts/
COPY --from=frameleaf studio ./studio/
RUN node studio/tools/engine.mjs prepare && \
    npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund && \
    RAYON_NUM_THREADS=2 TOKIO_WORKER_THREADS=2 npm --prefix studio/engine run build && \
    node studio/tools/bundled-worker-package.mjs /opt/frameleaf-studio
# The title families the server's render font catalogue resolves, installed as system fonts.
COPY --from=frameleaf server/resources/studio-fonts /opt/frameleaf-studio/fonts/
# Their SIL Open Font License travels with them; each family's copyright is in the notices below.
COPY --from=frameleaf licenses/texts/ofl-1.1.txt /opt/frameleaf-studio/fonts/OFL.txt

FROM ${NODE_RUNTIME_IMAGE} AS node-runtime

FROM builder-${DEVICE} AS builder

ARG DEVICE
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv

RUN apt-get update && apt-get install -y --no-install-recommends g++ ca-certificates && \
    test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem

COPY --from=ghcr.io/astral-sh/uv:0.13.4@sha256:9f130421e930bfbdc563c00740466603f8723158e90297d07957c2294640262b /uv /uvx /bin/
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --extra ${DEVICE} --no-dev --no-editable --no-install-project --compile-bytecode --no-progress --active --link-mode copy

FROM ${CPU_IMAGE} AS prod-cpu

ENV MACHINE_LEARNING_MODEL_ARENA=false

FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS prod-openvino

RUN apt-get update && \
    apt-get install --no-install-recommends -yqq ocl-icd-libopencl1 wget && \
    wget -nv https://github.com/intel/intel-graphics-compiler/releases/download/v2.41.5/intel-igc-core-2_2.41.5+22716_amd64.deb && \
    wget -nv https://github.com/intel/intel-graphics-compiler/releases/download/v2.41.5/intel-igc-opencl-2_2.41.5+22716_amd64.deb && \
    wget -nv https://github.com/intel/compute-runtime/releases/download/26.35.39758.10/intel-opencl-icd_26.35.39758.10-0_amd64.deb &&  \
    wget -nv https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-core_1.0.17537.24_amd64.deb && \
    wget -nv https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-opencl_1.0.17537.24_amd64.deb && \
    wget -nv https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb && \
    # TODO: Figure out how to get renovate to manage this differently versioned libigdgmm file
    wget -nv https://github.com/intel/compute-runtime/releases/download/26.35.39758.10/libigdgmm12_22.10.0_amd64.deb && \
    echo "0a6e64a663ae65a0fa02d6912ae3b6b37cf85b90c21cc423fd9fef70aaf4f628  intel-igc-core-2_2.41.5+22716_amd64.deb" | sha256sum --check - && \
    echo "779e1b9e88098eb25711e9a8f67c2752665bad22f134aa40ed5649f6e1b87058  intel-igc-opencl-2_2.41.5+22716_amd64.deb" | sha256sum --check - && \
    echo "61712caaddeba3d38e4f79e2a0fb23fea25596ca2d72c3144c6eea2331ec4301  intel-opencl-icd_26.35.39758.10-0_amd64.deb" | sha256sum --check - && \
    echo "6031a63d6e8a12ce61c14efc15f2c8e727061286e3820b8594e6d00615e04d54  libigdgmm12_22.10.0_amd64.deb" | sha256sum --check - && \
    dpkg -i *.deb && \
    rm *.deb && \
    apt-get remove wget -yqq && \
    rm -rf /var/lib/apt/lists/*

FROM ${CUDA_IMAGE} AS prod-cuda

ENV MACHINE_LEARNING_MODEL_ARENA=false

RUN apt-get update && \
    # Pascal support was dropped in 9.11
    apt-get install --no-install-recommends -yqq libcudnn9-cuda-12=9.10.2.21-1 tzdata && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder-cuda /opt/python /opt/python
RUN ln -s /opt/python/cpython-3.12.15-linux-$(uname -m)-gnu/bin/python3 /usr/local/bin/python3

FROM rocm/dev-ubuntu-24.04:7.2-complete@sha256:86e11093b4a7ec2a79b1b6701d10e840a6994f21c7e05929b51eb9be361c683a AS prod-rocm

RUN apt-get update && apt-get install --no-install-recommends -yqq migraphx miopen-hip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS prod-armnn

ENV LD_LIBRARY_PATH=/opt/armnn \
    MACHINE_LEARNING_MODEL_ARENA=false

RUN apt-get update && apt-get install -y --no-install-recommends ocl-icd-libopencl1 mesa-opencl-icd libgomp1 && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir --parents /etc/OpenCL/vendors && \
    echo "/usr/lib/libmali.so" > /etc/OpenCL/vendors/mali.icd && \
    mkdir /opt/armnn

COPY --from=builder-armnn \
    /opt/armnn/libarmnn.so.?? \
    /opt/armnn/libarmnnDeserializer.so.?? \
    /opt/armnn/libprotobuf.so.?.??.?.? \
    /opt/ann/libann.s[o] \
    /opt/ann/build.sh \
    /opt/armnn/

FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS prod-rknn

# renovate: datasource=github-tags depName=airockchip/rknn-toolkit2
ARG RKNN_TOOLKIT_VERSION="v2.3.2"

ENV MACHINE_LEARNING_MODEL_ARENA=false

ADD --chmod=644 --checksum=sha256:d31fc19c85b85f6091b2bd0f6af9d962d5264a4e410bfb536402ec92bac738e8 "https://github.com/airockchip/rknn-toolkit2/raw/refs/tags/${RKNN_TOOLKIT_VERSION}/rknpu2/runtime/Linux/librknn_api/aarch64/librknnrt.so" /usr/lib/

FROM prod-${DEVICE} AS prod

ARG DEVICE

# mimalloc is preloaded into the inference workers only (frameleaf_ml/__main__.py): a global
# /etc/ld.so.preload would also load it into the Studio worker's Chromium, which then crashes (FL-408).
# ONNX Runtime's ARM64 CPU visual session aborts in mimalloc 3; use the system allocator there.
RUN MIMALLOC=$(case "$DEVICE:$(uname -m)" in cuda:*) echo "libmimalloc2.0";; cpu:aarch64|openvino:*|rocm:*);; *) echo "libmimalloc3";; esac); \
    apt-get update && \
    apt-get install -y --no-install-recommends tini ccache libgl1 libglib2.0-0 libgomp1 $MIMALLOC && \
    apt-get autoremove -yqq && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    { [ -z "$MIMALLOC" ] || ls /usr/lib/*-linux-gnu/libmimalloc.so.? > /etc/frameleaf-mimalloc-preload; }

# FL-408: the Studio render worker's runtime: Node, a browser for the engine, ffmpeg to check and
# align what it encoded, Vulkan for WebGPU (the GPU when the container has one, else software).
COPY scripts/install-studio-runtime.sh /tmp/install-studio-runtime.sh
RUN sh /tmp/install-studio-runtime.sh && rm /tmp/install-studio-runtime.sh
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=studio-worker /opt/frameleaf-studio /opt/frameleaf-studio
RUN mkdir -p /usr/share/fonts/truetype/frameleaf-studio && \
    mv /opt/frameleaf-studio/fonts/*.ttf /opt/frameleaf-studio/fonts/OFL.txt /usr/share/fonts/truetype/frameleaf-studio/ && \
    rmdir /opt/frameleaf-studio/fonts && \
    fc-cache -f > /dev/null && \
    node --version
# Third-party notices, as the server image ships them (FL-86): every acknowledgement with its
# licence text, the Studio fonts' copyrights among them.
COPY --from=frameleaf licenses /licenses/third-party/

WORKDIR /usr/src
ENV TRANSFORMERS_CACHE=/cache \
    DO_NOT_TRACK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_UPDATE_CHECK=1 \
    HF_HUB_DISABLE_XET=1 \
    HF_XET_TELEMETRY_ENABLED=0 \
    ORT_DISABLE_TELEMETRY=1 \
    SCARF_NO_ANALYTICS=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/usr/src \
    DEVICE=${DEVICE} \
    VIRTUAL_ENV=/opt/venv \
    MACHINE_LEARNING_CACHE_FOLDER=/cache \
    FRAMELEAF_STUDIO_WORKER_ENTRY=/opt/frameleaf-studio/studio/tools/bundled-worker.mjs \
    FRAMELEAF_STUDIO_CHROMIUM=/usr/local/bin/frameleaf-studio-browser \
    FREECUT_CHROME_ARGS=--no-sandbox

# prevent core dumps
RUN echo "hard core 0" >> /etc/security/limits.conf && \
    echo "fs.suid_dumpable 0" >> /etc/sysctl.conf && \
    echo 'ulimit -S -c 0 > /dev/null 2>&1' >> /etc/profile

COPY --from=builder /opt/venv /opt/venv
COPY scripts/healthcheck.py .
COPY frameleaf_ml frameleaf_ml
COPY scripts/verify-semantic-runtime.py scripts/provision-semantic-models.py scripts/qualify-semantic-models.py ./scripts/
# Only CPU/CUDA advertise this native runtime; no weights are fetched during image construction.
RUN case "$DEVICE" in cpu|cuda) python scripts/verify-semantic-runtime.py ;; esac

ARG BUILD_ID
ARG BUILD_IMAGE
ARG BUILD_SOURCE_REF
ARG BUILD_SOURCE_COMMIT
ARG BUILD_SOURCE_REPOSITORY=Frameleaf/frameleaf-app
ARG BUILD_IMAGE_NAME=frameleaf-machine-learning

ENV FRAMELEAF_BUILD=${BUILD_ID}
ENV FRAMELEAF_BUILD_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}/actions/runs/${BUILD_ID}
ENV FRAMELEAF_BUILD_IMAGE=${BUILD_IMAGE}
ENV FRAMELEAF_BUILD_IMAGE_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}/pkgs/container/${BUILD_IMAGE_NAME}
ENV FRAMELEAF_REPOSITORY=${BUILD_SOURCE_REPOSITORY}
ENV FRAMELEAF_REPOSITORY_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}
ENV FRAMELEAF_SOURCE_REF=${BUILD_SOURCE_REF}
ENV FRAMELEAF_SOURCE_COMMIT=${BUILD_SOURCE_COMMIT}
ENV FRAMELEAF_SOURCE_COMMIT_URL=https://github.com/${BUILD_SOURCE_REPOSITORY}/commit/${BUILD_SOURCE_COMMIT}

LABEL org.opencontainers.image.source="https://github.com/${BUILD_SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${BUILD_SOURCE_COMMIT}"

# store huggingface in /cache subfolder to enable rootless deployment with a single volume
ENV HF_HOME=/cache/hf-cache

ENTRYPOINT ["tini", "--"]
CMD ["python", "-m", "frameleaf_ml"]

HEALTHCHECK CMD python3 healthcheck.py
