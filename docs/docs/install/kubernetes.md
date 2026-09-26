---
sidebar_position: 40
---

# Kubernetes

Frameleaf does not publish a Helm chart. Charts written for the upstream server can be adapted, but they are not tested with Frameleaf.

You can view some [examples](https://kubesearch.dev/#/immich) of how other people run the upstream server on Kubernetes.

:::caution DNS in Alpine containers
Frameleaf makes use of Alpine container images. These can encounter [a DNS resolution bug](https://stackoverflow.com/a/65593511) on Kubernetes clusters if the host
nodes have a search domain set, like:

```
$ cat /etc/resolv.conf
search home.lan
nameserver 192.168.1.1
```

:::
