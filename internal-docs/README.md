# Internal API and protocol documentation

[Complete API reference](api-reference/index.md) describes the source snapshot
recorded in [coverage.json](api-reference/coverage.json): every server OpenAPI
operation and schema, excluded HTTP aliases, authentication and mobile flows,
uploads, downloads, jobs, sync, Socket.IO, ML, render and Buddy worker protocols.
Cloud control-plane contracts are maintained separately with the Cloud service.

This directory is outside the public Docusaurus build. It includes Cloud,
administrative and service contracts and must not be copied into the retail
website or public API export. Public docs have a separate owner and scope.

After installing the server's locked dependencies, run from the repository root:

```sh
node scripts/generate-api-reference.cjs --check
node scripts/generate-api-reference.test.cjs
```

To regenerate the reference:

```sh
API_REFERENCE_REVISION=<reviewed-source-commit> node scripts/generate-api-reference.cjs
```

Handwritten guides must use that same source revision. The checker covers
controller routes, schemas, protocol source hashes and generated content.
Publication records and Confluence readback receipts are kept outside Git and
verified separately from the product contract.
