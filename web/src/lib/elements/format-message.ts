import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { printAST } from '@formatjs/icu-messageformat-parser/printer.js';
import { IntlMessageFormat, type FormatXMLElementFn, type PrimitiveType } from 'intl-messageformat';

export type InterpolationValues = Record<string, PrimitiveType | FormatXMLElementFn<unknown>>;

type MessagePart = { message: string; tag?: string };
type FormattingStep = (values: InterpolationValues) => MessagePart | MessagePart[];

/** Literal text written back as ICU source: apostrophes doubled, syntax characters quoted. */
const escapeLiteral = (value: string) => value.replaceAll("'", "''").replaceAll(/[{}<>]/g, (char) => `'${char}'`);

/**
 * A plural or select option with its arguments and literal text kept as ICU source, so picking the
 * branch never puts caller-provided values into the string that is parsed again. Nested plurals and
 * selects are still chosen here, so their tags come out as parts too.
 */
const keepArguments = (elements: MessageFormatElement[]): MessageFormatElement[] =>
  elements.map((element) => {
    switch (element.type) {
      case TYPE.literal: {
        return { ...element, value: escapeLiteral(element.value) };
      }
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time: {
        return { type: TYPE.literal, value: printAST([element]) };
      }
      case TYPE.select:
      case TYPE.plural: {
        return {
          ...element,
          options: Object.fromEntries(
            Object.entries(element.options).map(([key, option]) => [
              key,
              { ...option, value: keepArguments(option.value) },
            ]),
          ),
        };
      }
      case TYPE.tag: {
        return { ...element, children: keepArguments(element.children) };
      }
      default: {
        return element;
      }
    }
  });

/** Every tag inside a plural or select, at any depth, written back as markup for the second parse. */
const collectTags = (elements: MessageFormatElement[], replacements: Record<string, FormatXMLElementFn<unknown>>) => {
  for (const element of elements) {
    if (element.type === TYPE.tag) {
      const tag = element.value;
      replacements[tag] = (...parts) => `<${tag}>${parts.join('')}</${tag}>`;
      collectTags(element.children, replacements);
    } else if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) {
        collectTags(option.value, replacements);
      }
    }
  }
  return replacements;
};

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

    const replacements = collectTags([element], {});
    const [selector] = keepArguments([element]);
    const formatter = new IntlMessageFormat([selector], locale, undefined, { ignoreTag: true });
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
