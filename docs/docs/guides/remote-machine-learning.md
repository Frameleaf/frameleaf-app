# Machine learning on another computer

A separate Frameleaf machine-learning worker can use a more powerful CPU or GPU on your trusted network. The server sends the previews and requests needed for the selected tasks to that worker. Keep it private and use authentication; it is not a public photo-sharing endpoint.

## Start a worker

Use the current `latest` machine-learning image with a current server, or match your deliberately pinned server version and, when needed, that release's [hardware-acceleration configuration](/features/ml-hardware-acceleration). On the remote host, this standalone Compose example uses its own service name:

```yaml
name: frameleaf-remote-ml
services:
  machine-learning:
    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-latest}
    container_name: frameleaf_machine_learning
    env_file: .env
    volumes:
      - model-cache:/cache
    ports:
      - '3003:3003'
    restart: unless-stopped
volumes:
  model-cache:
```

Create a private `.env` containing the image tag and a private worker token:

```dotenv
FRAMELEAF_VERSION=latest
FRAMELEAF_ML_AUTH_TOKEN=YOUR_RANDOM_WORKER_TOKEN
```

Start with `docker compose up -d`. Limit port `3003` to your trusted network; use a trusted HTTPS proxy if the network requires TLS. Without `FRAMELEAF_ML_AUTH_TOKEN`, inference is unauthenticated.

## Add and route the worker

1. Open the server's **Workers & endpoints** / **Processing destinations** settings under **Compute & jobs**.
2. Add the worker's base URL, without a path, embedded password, query or fragment. Save its bearer token in the destination's credential field.
3. Allow only library-analysis tasks on this destination. Restoration uses a separate worker.
4. Select **Check capabilities** and review the reported models and acceleration.
5. Route the intended task types to this destination, then run a small sample and inspect progress.

See [Workers and endpoints](/administration/workers-and-endpoints) for the complete inventory and routing rules. Facial clustering uses stored face-detection output in PostgreSQL; moving inference does not move the database.

## If a worker is unavailable

A routed job stays associated with its chosen destination. A missing, disabled or unreachable destination causes refusal; work is not silently sent elsewhere. Correct the destination or deliberately reroute the task, then retry as offered in the job interface.

Removing a URL disables that destination; it does not stop the remote container or migrate its routes. Update remote workers with the server's matching release and retain their model cache to avoid downloading the same models again.
