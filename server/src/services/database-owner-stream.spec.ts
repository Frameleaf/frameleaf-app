import { Readable } from 'node:stream';
import { createSqlOwnerTransformStream } from 'src/services/database-backup.service.js';

const rewrite = async (chunks: Buffer[], username: string) => {
  const output: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(createSqlOwnerTransformStream(username))) {
    output.push(chunk);
  }
  return Buffer.concat(output);
};

describe('restore role substitution', () => {
  it.each(['x', 'longer_role_name', 'role"quoted', 'rôle'])(
    'replaces a full role with %s without mutating input',
    async (username) => {
      const sql = Buffer.from('ALTER TABLE public.asset OWNER TO "original_role";\n');
      const original = Buffer.from(sql);
      expect((await rewrite([sql], username)).toString()).toBe(
        `ALTER TABLE public.asset OWNER TO "${username.replaceAll('"', '""')}";\n`,
      );
      expect(sql).toEqual(original);
    },
  );

  it('handles every split point and preserves COPY payload bytes', async () => {
    const header = 'ALTER TABLE public.asset OWNER TO "old;role";\nCOPY public.asset FROM stdin;\n';
    const payload = Buffer.concat([
      Buffer.from('OWNER TO original;\n'),
      Buffer.from([0, 255, 128]),
      Buffer.from('\n\\.\n'),
    ]);
    const input = Buffer.concat([Buffer.from(header), payload]);
    const expected = Buffer.concat([
      Buffer.from('ALTER TABLE public.asset OWNER TO "x";\nCOPY public.asset FROM stdin;\n'),
      payload,
    ]);
    for (let index = 1; index < input.length; index++) {
      const chunks = [Buffer.from(input.subarray(0, index)), Buffer.from(input.subarray(index))];
      expect(await rewrite(chunks, 'x')).toEqual(expected);
    }
  });

  it('rewrites consecutive owners even with single-byte chunks', async () => {
    const input = Buffer.from('ALTER TABLE a OWNER TO old;\nALTER TABLE b OWNER TO "old";');
    expect(
      (
        await rewrite(
          [...input].map((byte) => Buffer.from([byte])),
          'new',
        )
      ).toString(),
    ).toBe('ALTER TABLE a OWNER TO "new";\nALTER TABLE b OWNER TO "new";');
  });
  it('preserves incomplete marker text but rejects an unterminated owner clause', async () => {
    expect((await rewrite([Buffer.from('SELECT 1;\nOWNER T')], 'new')).toString()).toBe('SELECT 1;\nOWNER T');
    await expect(rewrite([Buffer.from('ALTER TABLE a OWNER TO "old')], 'new')).rejects.toThrow(
      'Unterminated database owner statement',
    );
  });
});
