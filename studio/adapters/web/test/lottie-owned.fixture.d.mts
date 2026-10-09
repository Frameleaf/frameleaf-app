type Rgba = readonly [number, number, number, number];
export declare const animation: Record<string, unknown>;
export declare const edits: {
  colors: Record<string, string>;
  text: Record<string, string>;
  slots: Record<string, number | [number, number]>;
};
export declare const samples: ReadonlyArray<{
  name: string;
  x: number;
  y: number;
  authored?: Rgba;
  edited?: Rgba;
  frame0?: Rgba;
  frame30?: Rgba;
}>;
