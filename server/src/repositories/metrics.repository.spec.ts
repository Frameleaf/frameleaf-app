import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { JobName } from 'src/enum.js';
import { MetricsRepository } from 'src/repositories/metrics.repository.js';

describe(MetricsRepository.name, () => {
  const metrics = new MetricsRepository();
  afterEach(() => metrics.close());

  it('scrapes only the private listener, with a bearer token when configured', async () => {
    const url = await metrics.listen(0, '127.0.0.1', 'scrape-token');
    expect((await fetch(url)).status).toBe(401);
    const headers = { authorization: 'Bearer scrape-token' };
    expect((await fetch(url, { headers: { ...headers, 'x-frameleaf-via': 'relay' } })).status).toBe(404);
    expect((await fetch(url, { headers: { ...headers, 'x-forwarded-for': '203.0.113.1' } })).status).toBe(404);
    const api = express();
    api.use(metrics.middleware());
    api.get('/api/assets/:id', (_req, res) => res.sendStatus(200));
    await request(api).get('/api/assets/private-file-id?token=private-query').expect(200);
    await request(api).get('/api/unknown-private-path').expect(404);
    await request(api).get('/metrics').expect(404);
    metrics.observeJob(JobName.AssetGenerateThumbnails, 'completed');
    const result = await fetch(url, { headers });
    expect(result.status).toBe(200);
    const body = await result.text();
    expect(body).toContain('frameleaf_http_request_duration_seconds_count{route="/api/assets/:id",status="200"} 1');
    expect(body).toContain('frameleaf_jobs_total');
    for (const privateValue of ['scrape-token', 'private-file-id', 'private-query', 'unknown-private-path']) {
      expect(body).not.toContain(privateValue);
    }
  });
});
