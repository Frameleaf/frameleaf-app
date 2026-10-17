FROM myoung34/github-runner:ubuntu-noble@sha256:7f70743afb5cf8b71522e59ae34a908dc2c28b95090cf33e856f94cd5a3e6eb2

USER root
RUN apt-get update && apt-get install -y --no-install-recommends python-is-python3 python3-yaml libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
