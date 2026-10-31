import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { IntlMessageFormat, type FormatXMLElementFn, type PrimitiveType } from 'intl-messageformat';

export type InterpolationValues = Record<string, PrimitiveType | FormatXMLElementFn<unknown>>;

type MessagePart = { message: string; tag?: string };
type FormattingStep = (values: InterpolationValues) => MessagePart | MessagePart[];

export const createMessageFormatter = (message: string, locale: string) => {
  const compilePart = (element: MessageFormatElement) => {
    const tag = element.type === TYPE.tag ? element.value : undefined;
    const formatter = new IntlMessageFormat(
      element.type === TYPE.tag ? element.children : [element],
      locale,
      undefined,
      {
        ignoreTag: true,
      },
    );
    return (values: InterpolationValues): MessagePart => ({ tag, message: formatter.format(values) as string });
  };

  const compileStep = (element: MessageFormatElement): FormattingStep => {
    if (element.type !== TYPE.plural && element.type !== TYPE.select) {
      return compilePart(element);
    }

    const replacements: Record<string, FormatXMLElementFn<unknown>> = {};
    for (const option of Object.values(element.options)) {
      for (const child of option.value) {
        if (child.type === TYPE.tag) {
          const tag = child.value;
          replacements[tag] = (...parts) => `<${tag}>${parts}</${tag}>`;
        }
      }
    }
    const formatter = new IntlMessageFormat([element], locale, undefined, { ignoreTag: true });
    return (values) => {
      const selected = formatter.format({ ...values, ...replacements }) as string;
      const elements = new IntlMessageFormat(selected, locale, undefined, { ignoreTag: false }).getAst();
      return elements.map((part) => compilePart(part)(values));
    };
  };

  // Compile lazily so parse/format failures share the component's raw-message fallback.
  let steps: FormattingStep[] | undefined;
  return (values: InterpolationValues): MessagePart[] => {
    steps ??= new IntlMessageFormat(message, locale, undefined, { ignoreTag: false })
      .getAst()
      .map((element) => compileStep(element));
    const parts: MessagePart[] = [];
    for (const format of steps) {
      const result = format(values);
      if (Array.isArray(result)) {
        parts.push(...result);
      } else {
        parts.push(result);
      }
    }
    return parts;
  };
};
