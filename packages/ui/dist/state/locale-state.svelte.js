let locale = $state();
export const getLocale = () => locale;
export const setLocale = (newLocale) => {
    locale = newLocale;
};
