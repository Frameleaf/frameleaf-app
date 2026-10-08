# Database GUI

A PostgreSQL client such as pgAdmin can inspect a manually managed Frameleaf database. Routine library changes belong in the application; direct database access bypasses account privacy and application validation. Follow [Database inspection](/guides/database-queries) for read-only diagnostics.

Connect the client to a private network that can reach the database. Do not expose PostgreSQL or a database-administration interface publicly just to inspect the library.

| Field    | Value                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Host     | The database's reachable private hostname; the manual release stack uses `database` on its Compose network |
| Port     | `5432`, unless configured otherwise                                                                        |
| Database | Your `DB_DATABASE_NAME`, normally `frameleaf`                                                              |
| Username | Your `DB_USERNAME`                                                                                         |
| Password | Your private configured database password                                                                  |

The release does not publish PostgreSQL to the host by default. A separate client container must join the correct existing private Docker network; preserve that stack's project and volumes. Manager-generated installations use their own connection details. Do not paste secrets or query results into a public support report.
