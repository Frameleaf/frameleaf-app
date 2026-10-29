import { Kysely, sql } from 'kysely';

// FL-655: Save to Frameleaf signs in with your Frameleaf account. Sign-in codes (hashed, single use,
// five minutes) and the accesses they became, which are ordinary API keys marked as added by signing in.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "browser_extension_sign_in_code" (
  "codeHash" bytea NOT NULL,
  "userId" uuid NOT NULL,
  "sessionId" uuid NOT NULL,
  "codeChallenge" character varying NOT NULL,
  "redirectUri" character varying NOT NULL,
  "client" character varying NOT NULL,
  "installationId" character varying NOT NULL,
  "serverId" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "expiresAt" timestamp with time zone NOT NULL,
  CONSTRAINT "browser_extension_sign_in_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "browser_extension_sign_in_code_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "browser_extension_sign_in_code_client_check" CHECK ("client" IN ('chrome', 'edge')),
  CONSTRAINT "browser_extension_sign_in_code_hash_check" CHECK (octet_length("codeHash") = 32),
  CONSTRAINT "browser_extension_sign_in_code_pkey" PRIMARY KEY ("codeHash")
);`.execute(db);
  await sql`CREATE INDEX "browser_extension_sign_in_code_expiresAt_idx" ON "browser_extension_sign_in_code" ("expiresAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "browser_extension_sign_in_code_userId_idx" ON "browser_extension_sign_in_code" ("userId");`.execute(
    db,
  );
  await sql`CREATE INDEX "browser_extension_sign_in_code_sessionId_idx" ON "browser_extension_sign_in_code" ("sessionId");`.execute(
    db,
  );
  await sql`CREATE TABLE "browser_extension_access" (
  "apiKeyId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "client" character varying NOT NULL,
  "redirectOrigin" character varying NOT NULL,
  "installationId" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "browser_extension_access_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_key" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "browser_extension_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "browser_extension_access_client_check" CHECK ("client" IN ('chrome', 'edge')),
  CONSTRAINT "browser_extension_access_pkey" PRIMARY KEY ("apiKeyId")
);`.execute(db);
  await sql`CREATE INDEX "browser_extension_access_userId_client_redirectOrigin_installationId_idx" ON "browser_extension_access" ("userId", "client", "redirectOrigin", "installationId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // Removing these signs every browser out of Save to Frameleaf; their keys stay in API keys.
  await sql`DROP TABLE "browser_extension_access";`.execute(db);
  await sql`DROP TABLE "browser_extension_sign_in_code";`.execute(db);
}
