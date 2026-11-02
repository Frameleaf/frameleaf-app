/**
 * FL-667: the words AI description tagging never makes into a tag (FL-659), mirrored from
 * `TAG_STOP_WORDS` in `machine-learning/frameleaf_ml/models/image_description.py`. The ML service
 * applies the list to new descriptions; the server uses it to remove the filler tags that
 * descriptions made before the list existed. `description-tag-stop-words.spec.ts` fails when the
 * two copies differ, so a change to either must be made to both.
 */
export const DESCRIPTION_TAG_STOP_WORDS: ReadonlySet<string> = new Set([
  // articles, conjunctions, determiners, quantifiers
  ...'the and but nor yet for are was were has had have been being does did not also than then'.split(' '),
  ...'this that these those there here what which who whom whose when where while why how'.split(' '),
  ...'all any each every both either neither few many much more most other others another some such'.split(' '),
  ...'only own same just very too quite rather really almost nearly mostly mainly partly several'.split(' '),
  ..."its it's one ones none nothing something someone somebody anything anyone everything everyone".split(' '),
  // pronouns
  ...'you your yours she her hers him his they them their theirs our ours ourselves themselves'.split(' '),
  ...'himself herself itself yourself myself'.split(' '),
  // prepositions and positions
  ...'about above across after against along alongside amid among around atop before behind below'.split(' '),
  ...'beneath beside besides between beyond by down during except from inside into near nearby'.split(' '),
  ...'off onto out outside over past per since through throughout toward towards under underneath'.split(' '),
  ...'until upon via with within without top bottom front back side sides left right middle center'.split(' '),
  ...'centre corner edge foreground background distance upper lower far close away together'.split(' '),
  // numbers and counting words
  ...'two three four five six seven eight nine ten eleven twelve twenty thirty hundred thousand'.split(' '),
  ...'first second third fourth fifth last single double pair couple group number'.split(' '),
  // colours and plain adjectives
  ...'white black grey gray red blue green yellow orange purple pink brown beige gold silver'.split(' '),
  ...'dark light bright colorful colourful large small big little tall short long wide old new'.split(' '),
  ...'young various different several visible clear blurry full empty other'.split(' '),
  // describing verbs and photo-framing words
  ...'can could will would should may might must shall appears appear appearing seems seem'.split(' '),
  ...'wearing standing sitting holding looking showing shown seen looks wears holds stands sits'.split(' '),
  ...'shows depicts depicting featuring features captured taken placed located visible displayed'.split(' '),
  ...'image images photo photos photograph picture pictures shot scene view frame closeup close-up'.split(' '),
  ...'overall likely possibly perhaps something like looks kind type part parts area areas'.split(' '),
]);
