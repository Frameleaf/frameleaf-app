/**
 * A small XML tree for the editor readers (FL-1546). The files are untrusted, so saxes reads them: it
 * never fetches a DTD or an external entity, and an entity it does not know is an error rather than an
 * expansion. Size, depth and element count are capped before anything else is built.
 */
import { SaxesParser } from 'saxes';
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';

export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

export type XmlLimits = { maxBytes: number; maxDepth: number; maxElements: number };
export const XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: 128 * 1024 * 1024,
  maxDepth: 256,
  maxElements: 2_000_000,
});

export const parseXml = (bytes: Buffer | string, limits = XML_LIMITS): XmlNode => {
  const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (length > limits.maxBytes) {
    throw new InterchangeReadError('too-large', 'The project file is too large to read');
  }
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    if (stack.length >= limits.maxDepth || ++count > limits.maxElements) {
      throw new InterchangeReadError('too-complex', 'The project file is too deeply nested or too large to read');
    }
    const node: XmlNode = { name: tag.name, attributes: {}, children: [], text: '' };
    for (const [key, value] of Object.entries(tag.attributes)) {
      node.attributes[key] = value;
    }
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(node);
    } else if (root) {
      throw new InterchangeReadError('malformed', 'The project file has more than one root element');
    } else {
      root = node;
    }
    stack.push(node);
  });
  const addText = (value: string) => {
    const node = stack.at(-1);
    if (node && node.text.length < 1_000_000) {
      node.text += value;
    }
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(typeof bytes === 'string' ? bytes : bytes.toString('utf8')).close();
  } catch (error) {
    if (error instanceof InterchangeReadError) {
      throw error;
    }
    throw new InterchangeReadError('malformed', 'The project file is not well-formed XML');
  }
  if (!root) {
    throw new InterchangeReadError('malformed', 'The project file is empty');
  }
  return root;
};

/** The first child with this name. */
export const child = (node: XmlNode | undefined, name: string) => node?.children.find((item) => item.name === name);
export const children = (node: XmlNode | undefined, name: string) =>
  node?.children.filter((item) => item.name === name) ?? [];
/** A child's trimmed text, or undefined. */
export const childText = (node: XmlNode | undefined, name: string) => {
  const text = child(node, name)?.text.trim();
  return text || undefined;
};
/** Every descendant with this name, depth first, in document order. */
export const descendants = (node: XmlNode, name: string, into: XmlNode[] = []): XmlNode[] => {
  for (const item of node.children) {
    if (item.name === name) {
      into.push(item);
    }
    descendants(item, name, into);
  }
  return into;
};
/** All the text below a node, in order. */
export const allText = (node: XmlNode): string => node.text + node.children.map((item) => allText(item)).join('');
