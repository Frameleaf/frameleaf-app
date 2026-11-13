import { BadRequestException } from '@nestjs/common';
import { SaxesParser } from 'saxes';
import { validateXmp } from 'src/utils/xmp-sidecar.js';

// XML namespace identifiers are exact strings, not network requests.
/* eslint-disable unicorn/prefer-https */
export const LIGHTROOM_NAMESPACE = 'http://ns.adobe.com/camera-raw-settings/1.0/';
export const DARKTABLE_NAMESPACE = 'http://darktable.sf.net/';
export type XmpNode = {
  name: string;
  namespace: string;
  value: string;
  attributes: Record<string, string>;
  children: XmpNode[];
};

/** Namespaces, rather than chosen prefixes, identify external develop settings. */
export function readDevelopXmp(data: Buffer): XmpNode[] {
  validateXmp(data);
  const roots: XmpNode[] = [];
  const stack: XmpNode[] = [];
  let count = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (stack.length >= 16 || ++count > 32_768) throw new BadRequestException('XMP settings are too complex');
    const node: XmpNode = { name: tag.local, namespace: tag.uri, value: '', attributes: {}, children: [] };
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === LIGHTROOM_NAMESPACE || attribute.uri === DARKTABLE_NAMESPACE) {
        node.children.push({
          name: attribute.local,
          namespace: attribute.uri,
          value: attribute.value,
          attributes: {},
          children: [],
        });
      }
      node.attributes[attribute.local] = attribute.value;
    }
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  });
  parser.on('text', (value) => {
    const node = stack.at(-1);
    if (node) node.value += value;
  });
  parser.on('cdata', (value) => {
    const node = stack.at(-1);
    if (node) node.value += value;
  });
  parser.on('closetag', () => {
    const node = stack.pop();
    if (node) node.value = node.value.trim();
  });
  parser.write(data.toString('utf8')).close();
  return roots;
}

export function settingsFor(nodes: XmpNode[], namespace: string): XmpNode[] {
  return nodes.flatMap((node) => (node.namespace === namespace ? [node] : settingsFor(node.children, namespace)));
}
export function xmpValue(node: XmpNode): string | string[] {
  const children = node.children.flatMap((child): string[] => {
    const value = xmpValue(child);
    return Array.isArray(value) ? value : [value];
  });
  return children.length > 0 ? children : node.value.trim();
}
