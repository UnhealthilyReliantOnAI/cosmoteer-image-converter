import { I18nProvider, useI18n } from './i18n';
import { ImageConverter } from './ImageConverter';
import type { Language } from './translations';

interface AppProps {
  readonly initialLanguage?: Language;
}

export function App({ initialLanguage }: AppProps) {
  return <I18nProvider {...(initialLanguage ? { initial: initialLanguage } : {})}><Application /></I18nProvider>;
}

function Application() {
  const { t, language, setLanguage } = useI18n();
  return <main className="home">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">◈</span>
        <div>
          <h1>Cosmoteer Image Converter</h1>
          <p>{t('intro')}</p>
        </div>
      </div>
      <div className="topbar-actions">
        <span className="local-badge">{t('local')}</span>
        <label>
          {t('language')}
          <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
    </header>
    <p className="help">
      {t('unofficial')} <a href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`}>{t('thirdPartyNotices')}</a>
    </p>
    <ImageConverter />
  </main>;
}
