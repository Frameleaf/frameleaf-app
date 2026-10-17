import { t } from 'svelte-i18n';
import { derived, get } from 'svelte/store';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { locale } from '$lib/stores/preferences.store';
import { fromTimelinePlainDateTime } from '$lib/utils/timeline-util';

export const getAltText = derived(t, ($t) => {
  let formatter: Intl.DateTimeFormat | undefined;
  let formatterLocale: string | undefined;
  const dateOptions = { dateStyle: 'long', timeZone: 'UTC' } as const;
  const peopleSuffixes = ['', '_1_person', '_2_people', '_3_people', '_4_or_more_people'] as const;

  return (asset: TimelineAsset) => {
    const jsDate = fromTimelinePlainDateTime(asset.localDateTime).toJSDate();
    const currentLocale = get(locale);
    let date: string;
    if (Number.isNaN(jsDate.getTime())) {
      // Date.toLocaleString returns Invalid Date before checking locale; Intl.format throws instead.
      date = jsDate.toLocaleString(currentLocale, dateOptions);
    } else {
      if (!formatter || formatterLocale !== currentLocale) {
        formatter = new Intl.DateTimeFormat(currentLocale, dateOptions);
        formatterLocale = currentLocale;
      }
      date = formatter.format(jsDate);
    }
    const hasPlace = asset.city && asset.country;

    const peopleCount = asset.people?.length ?? 0;
    const isVideo = asset.isVideo;

    const values = {
      date,
      city: asset.city,
      country: asset.country,
      person1: asset.people?.[0],
      person2: asset.people?.[1],
      person3: asset.people?.[2],
      isVideo,
      additionalCount: peopleCount > 3 ? peopleCount - 2 : 0,
    };

    const peopleSuffix = peopleSuffixes[Math.min(peopleCount, 4)];
    return $t(`image_alt_text_date${hasPlace ? '_place' : ''}${peopleSuffix}`, { values });
  };
});
