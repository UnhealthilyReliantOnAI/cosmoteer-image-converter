import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { initialLanguage, translate } from './translations';
import type { Language, MessageKey } from './translations';

const I18nContext = createContext({
  language: 'en' as Language,
  setLanguage: (_value: Language) => {},
  t: (key: MessageKey, values?: Record<string, string | number>) => translate('en', key, values),
  number: (value: number, digits = 0) => value.toLocaleString('en', { maximumFractionDigits: digits }),
});

interface I18nProviderProps {
  readonly children: ReactNode;
  readonly initial?: Language;
}

export function I18nProvider({ children, initial }: I18nProviderProps) {
  const [language, setLanguage] = useState<Language>(() => {
    if (initial) return initial;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('cosmoteer-language');
    } catch { /* Optional persistence. */ }
    return initialLanguage(saved, typeof navigator === 'undefined' ? 'en' : navigator.language);
  });
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return <I18nContext.Provider
    value={{
      language,
      setLanguage: (value) => {
        setLanguage(value);
        try {
          localStorage.setItem('cosmoteer-language', value);
        } catch { /* Private browsing may disable storage. */ }
      },
      t: (key, values) => translate(language, key, values),
      number: (value, digits = 0) => value.toLocaleString(language, { maximumFractionDigits: digits }),
    }}
  >{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
