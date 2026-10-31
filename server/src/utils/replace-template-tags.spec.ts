import { replaceTemplateTags } from 'src/utils/replace-template-tags.js';

describe('replaceTemplateTags', () => {
  it('keeps missing and inherited placeholders unchanged', () => {
    const template = '{missing}|{constructor}|{__proto__}|{toString}';
    expect(replaceTemplateTags(template, {})).toBe(template);
  });

  it('escapes substituted HTML while retaining the template markup', () => {
    expect(replaceTemplateTags('<p title="{name}">{name}</p>', { name: '<b>"&\'' })).toBe(
      '<p title="&lt;b&gt;&quot;&amp;&#39;">&lt;b&gt;&quot;&amp;&#39;</p>',
    );
  });

  it('preserves empty, undefined and explicit own-property variables without recursive substitution', () => {
    expect(
      replaceTemplateTags('{empty}|{unset}|{constructor}|{value}', {
        empty: '',
        unset: undefined,
        constructor: 'own',
        value: '{empty}',
      }),
    ).toBe('|{unset}|own|{empty}');
  });
});
