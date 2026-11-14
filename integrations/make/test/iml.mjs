// Test-only runner for the Make component JSON in this directory. It implements the small IML
// subset these components use, so tests exercise the shipped JSON rather than a copy of it.
// ponytail: not Make's engine; native qualification in Make still decides (see README).
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
export const MAKE_CALLBACK = 'https://www.make.com/oauth/cb/app';

export async function loadApp() {
  const modules = {};
  for (const id of await readdir(new URL('modules/', root))) {
    const read = (name) => json(`modules/${id}/${name}.json`);
    modules[id] = {
      id,
      ...(await read('module')),
      communication: await read('communication'),
      parameters: await read('parameters'),
      interface: await read('interface'),
    };
  }
  return {
    base: await json('base/base.json'),
    groups: await json('groups.json'),
    connection: {
      communication: await json('connection/communication.json'),
      parameters: await json('connection/parameters.json'),
      scope: await json('connection/scope.json'),
      scopes: await json('connection/scopes.json'),
    },
    rpcs: {
      albums: {
        communication: await json('rpcs/albums/communication.json'),
        parameters: await json('rpcs/albums/parameters.json'),
      },
    },
    modules,
  };
}

// ---- expressions
const TOKEN = /\s*(?:(\d+)|'([^']*)'|`([^`]*)`|([A-Za-z_]\w*)|(&&|\|\||==|!=|<=|>=|[=<>+\-*/!(),.]))/y;
function tokenize(source) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(TOKEN.lastIndex))) break;
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`Unsupported IML: ${source}`);
    const [, number, string, quoted, ident, op] = match;
    tokens.push(
      number !== undefined
        ? { number: Number(number) }
        : string !== undefined
          ? { string }
          : quoted !== undefined
            ? { ident: quoted, quoted: true }
            : ident !== undefined
              ? { ident }
              : { op },
    );
  }
  return tokens;
}

const empty = (value) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
const time = (value) =>
  value instanceof Date ? value.getTime() : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : value;

const FUNCTIONS = {
  ifempty: (...values) => values.find((value) => !empty(value)),
  if: (condition, yes, no) => (condition ? yes : no),
  join: (values, separator) => (values ?? []).join(separator),
  length: (value) => value?.length ?? 0,
  lower: (value) => String(value ?? '').toLowerCase(),
  split: (value, separator) => String(value ?? '').split(separator),
  last: (values) => values?.at(-1),
  switch: (value, ...cases) => {
    for (let index = 0; index + 1 < cases.length; index += 2) if (cases[index] === value) return cases[index + 1];
    return cases.length % 2 ? cases.at(-1) : undefined;
  },
  sha256: (value, encoding = 'hex') => createHash('sha256').update(value).digest(encoding === 'base64' ? 'base64' : 'hex'),
  base64url: (value) => String(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  addSeconds: (date, seconds) => new Date(new Date(date).getTime() + Number(seconds) * 1000),
  addMinutes: (date, minutes) => new Date(new Date(date).getTime() + Number(minutes) * 60_000),
  encodeURL: (value) => encodeURIComponent(String(value ?? '')),
  toCollection: (values, key, value) =>
    empty(values) ? undefined : Object.fromEntries(values.map((entry) => [entry[key], entry[value]])),
};

export function evaluate(source, context) {
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = (op) => (peek()?.op === op ? (index++, true) : false);
  const expect = (op) => {
    if (!take(op)) throw new Error(`Expected ${op} in ${source}`);
  };
  const binary = (next, ops, apply) => () => {
    let left = next();
    for (let op; (op = ops.find((candidate) => peek()?.op === candidate)); ) {
      index++;
      left = apply(op, left, next());
    }
    return left;
  };
  const primary = () => {
    const token = tokens[index++];
    if (!token) throw new Error(`Unexpected end of ${source}`);
    let value;
    if (token.number !== undefined) value = token.number;
    else if (token.string !== undefined) value = token.string;
    else if (token.op === '(') {
      value = or();
      expect(')');
    } else if (token.op === '!') return !unary();
    else if (token.ident && !token.quoted && peek()?.op === '(') {
      index++;
      const args = [];
      if (!take(')')) {
        do args.push(or());
        while (take(','));
        expect(')');
      }
      if (!Object.hasOwn(FUNCTIONS, token.ident)) throw new Error(`Unsupported function ${token.ident}`);
      value = FUNCTIONS[token.ident](...args);
    } else if (token.ident) {
      const constants = { true: true, false: false, null: null, undefined, now: context.now ?? new Date(), uuid: randomUUID() };
      value = Object.hasOwn(constants, token.ident) ? constants[token.ident] : context[token.ident];
    } else throw new Error(`Unexpected ${token.op} in ${source}`);
    while (take('.')) {
      const key = tokens[index++];
      value = value?.[key.ident ?? key.number];
    }
    return value;
  };
  const unary = () => primary();
  const mul = binary(unary, ['*', '/'], (op, a, b) => (op === '*' ? a * b : a / b));
  const add = binary(mul, ['+', '-'], (op, a, b) =>
    op === '-' ? a - b : typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : a + b,
  );
  const compare = binary(add, ['=', '==', '!=', '<=', '>=', '<', '>'], (op, a, b) => {
    [a, b] = [time(a), time(b)];
    // eslint-disable-next-line eqeqeq
    return { '=': a == b, '==': a == b, '!=': a != b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[op];
  });
  const and = binary(compare, ['&&'], (_, a, b) => a && b);
  const or = binary(and, ['||'], (_, a, b) => a || b);
  const result = or();
  if (index !== tokens.length) throw new Error(`Unparsed IML in ${source}`);
  return result;
}

export function render(value, context) {
  if (typeof value === 'string') {
    const whole = /^\{\{([\s\S]*?)\}\}$/.exec(value);
    if (whole && !whole[1].includes('{{')) return evaluate(whole[1], context);
    return value.replaceAll(/\{\{([\s\S]*?)\}\}/g, (_, source) => {
      const result = evaluate(source, context);
      return result === undefined || result === null ? '' : result instanceof Date ? result.toISOString() : String(result);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => render(entry, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = render(entry, context);
      if (result !== undefined) out[key] = result;
    }
    return out;
  }
  return value;
}

// ---- Make's runtime parameter validation
export class ValidationError extends Error {}
function check(spec, value, path) {
  const fail = (why) => {
    throw new ValidationError(`Validation failed for ${path}: ${why}`);
  };
  if (empty(value)) {
    if (spec.required) fail('required');
    return;
  }
  const rule = spec.validate ?? {};
  if (['text', 'select', 'filename'].includes(spec.type)) {
    const text = String(value);
    if (rule.pattern && !new RegExp(rule.pattern).test(text)) fail('pattern');
    if (rule.max !== undefined && text.length > rule.max) fail('too long');
    if (rule.min !== undefined && text.length < rule.min) fail('too short');
    if (spec.type === 'select' && Array.isArray(spec.options) && !spec.options.some((option) => option.value === value))
      fail('unknown option');
  }
  if (spec.type === 'uinteger' && (!Number.isInteger(value) || value < 0 || (rule.max !== undefined && value > rule.max)))
    fail('range');
  if (spec.type === 'buffer' && !Buffer.isBuffer(value)) fail('not a file');
  if (spec.type === 'array') {
    if (!Array.isArray(value)) fail('not an array');
    if (rule.minItems !== undefined && value.length < rule.minItems) fail('too few items');
    if (rule.maxItems !== undefined && value.length > rule.maxItems) fail('too many items');
    value.forEach((entry, position) =>
      Array.isArray(spec.spec)
        ? validate(spec.spec, entry, `${path}[${position}]`)
        : spec.spec && check(spec.spec, entry, `${path}[${position}]`),
    );
  }
}
export function validate(specs, parameters, path = 'parameters') {
  for (const spec of specs) check(spec, parameters?.[spec.name], `${path}.${spec.name}`);
}

// ---- HTTP
export class MakeError extends Error {
  constructor(type, message, statusCode) {
    super(message);
    Object.assign(this, { type, statusCode });
  }
}

async function send(step, context, { fetch, baseUrl, baseHeaders = {}, errors, pagination }) {
  let url = render(step.url, context);
  if (!/^https?:\/\//.test(url)) url = `${render(baseUrl, context)}${url}`;
  const query = new URLSearchParams();
  const qs = { ...render(step.qs ?? {}, context), ...(pagination ? render(pagination.qs, pagination.context) : {}) };
  for (const [key, value] of Object.entries(qs ?? {})) if (!empty(value)) query.set(key, String(value));
  if ([...query].length) url += `?${query}`;
  const headers = { ...render(baseHeaders, context), ...render(step.headers ?? {}, context) };
  let body = step.body === undefined ? undefined : render(step.body, context);
  if (body !== undefined && step.type === 'urlencoded') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(body).toString();
  } else if (body !== undefined && step.type !== 'binary') {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(body);
  }
  const method = render(step.method ?? 'GET', context);
  const response = await fetch(url, { method, headers, body, redirect: 'manual' });
  const responseHeaders = Object.fromEntries(response.headers);
  const bytes = Buffer.from(await response.arrayBuffer());
  const parsed =
    step.response?.type === 'binary' && response.ok
      ? bytes
      : responseHeaders['content-type']?.includes('json')
        ? JSON.parse(bytes.toString('utf8'))
        : bytes.toString('utf8');
  const result = { ...context, statusCode: response.status, headers: responseHeaders, body: parsed, request: { url, method, headers } };
  const valid = step.response?.valid === undefined ? response.ok : render(step.response.valid, result);
  if (!valid || !response.ok) {
    const spec = { ...errors, ...step.response?.error };
    const detail = spec[response.status] ?? spec;
    throw new MakeError(detail.type ?? spec.type, render(detail.message ?? spec.message, result), response.status);
  }
  return result;
}

// ---- connection lifecycle
export function connectionContext(state, extra = {}) {
  return { parameters: state.parameters, data: state.data, connection: { ...state.parameters, ...state.data }, ...extra };
}

export async function connect(app, parameters, { fetch, consent, scopes = [] }) {
  validate(app.connection.parameters, parameters, 'connection');
  const { authorize, token, info } = app.connection.communication;
  const oauth = { scope: [...new Set([...app.connection.scope, ...scopes])], makeRedirectUri: MAKE_CALLBACK };
  const temp = render(authorize.temp ?? {}, { parameters, oauth });
  const context = { parameters, oauth, temp };
  const url = new URL(render(authorize.url, context));
  for (const [key, value] of Object.entries(render(authorize.qs, context))) url.searchParams.set(key, value);
  Object.assign(temp, render(authorize.response.temp, { ...context, query: await consent(url) }));
  const exchanged = await send(token, context, { fetch });
  const state = { parameters, data: render(token.response.data, exchanged), authorizeUrl: url, grantedScopes: oauth.scope };
  const verified = await send(info, connectionContext(state), { fetch });
  state.metadata = render(info.response.metadata, verified);
  return state;
}

export async function refreshIfDue(app, state, { fetch, now }) {
  const { refresh } = app.connection.communication;
  if (!render(refresh.condition, connectionContext(state, { now }))) return false;
  const result = await send(refresh, connectionContext(state, { now }), { fetch });
  state.data = { ...state.data, ...render(refresh.response.data, result) };
  return true;
}

export async function disconnect(app, state, { fetch }) {
  await send(app.connection.communication.invalidate, connectionContext(state), { fetch });
}

// ---- modules and RPCs
async function execute(app, communication, parameters, state, { fetch, now, trigger }) {
  const steps = Array.isArray(communication) ? communication : [communication];
  const temp = {};
  const options = { fetch, baseUrl: app.base.baseUrl, baseHeaders: app.base.headers, errors: app.base.response.error };
  let output;
  const outputs = [];
  for (const step of steps) {
    const context = connectionContext(state, { parameters, temp, now });
    if (step.condition !== undefined && !render(step.condition, context)) continue;
    let result = await send(step, context, options);
    if (step.response?.temp) Object.assign(temp, render(step.response.temp, result));
    if (!step.response?.iterate) {
      if (step.response?.output !== undefined) output = render(step.response.output, result);
      continue;
    }
    const limit = Number(render(step.response.limit ?? 3200, result));
    const iterate = step.response.iterate;
    const container = typeof iterate === 'string' ? iterate : iterate.container;
    let stop = false;
    for (;;) {
      const page = render(container, result) ?? [];
      for (const item of page) {
        const itemContext = { ...result, item };
        if (typeof iterate === 'object' && iterate.condition && !render(iterate.condition, itemContext)) continue;
        if (trigger && step.response.trigger) {
          const mark = render(step.response.trigger, itemContext);
          if (trigger.lastDate && (time(mark.date) < time(trigger.lastDate) || mark.id === trigger.lastId)) {
            stop = true;
            break;
          }
          outputs.mark ??= mark;
        }
        outputs.push(step.response.output === undefined ? item : render(step.response.output, itemContext));
        if (outputs.length >= limit) break;
      }
      if (stop || page.length === 0 || outputs.length >= limit || !step.pagination || !render(step.pagination.condition, result)) break;
      result = await send(step, context, { ...options, pagination: { qs: step.pagination.qs, context: result } });
    }
  }
  if (trigger && outputs.mark) Object.assign(trigger, { lastDate: outputs.mark.date, lastId: outputs.mark.id });
  return outputs.length || steps.some((step) => step.response?.iterate) ? outputs : output;
}

export async function runModule(app, id, parameters, state, { fetch, now, trigger } = {}) {
  const module = app.modules[id];
  validate(module.parameters, parameters);
  const missing = module.scope.filter((scope) => !state.grantedScopes?.includes(scope));
  if (missing.length) throw new MakeError('InvalidConfigurationError', `Reconnect to allow ${missing.join(', ')}`);
  await refreshIfDue(app, state, { fetch, now });
  return execute(app, module.communication, parameters, state, { fetch, now, trigger });
}

export async function runRpc(app, id, parameters, state, { fetch, now } = {}) {
  validate(app.rpcs[id].parameters, parameters);
  await refreshIfDue(app, state, { fetch, now });
  return execute(app, app.rpcs[id].communication, parameters, state, { fetch, now });
}
