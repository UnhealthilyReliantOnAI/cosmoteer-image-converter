import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { installWindowImageDrop } from './imageImportEvents';
import type { DropState } from './imageImportEvents';

export function ImageDropOverlay({ onFile }: {
    onFile: (file: File) => void;
  }) {
  const { t } = useI18n();
  const [state, setState] = useState<DropState>({ visible: false, cancelling: false });
  const importer = useRef(onFile);
  const cancel = useRef<() => void>(() => {});
  useEffect(() => {
    importer.current = onFile;
  }, [onFile]);
  useEffect(() => {
    const control = installWindowImageDrop(window, (file) => importer.current(file), setState);
    cancel.current = control.cancel;
    return control.dispose;
  }, []);
  if (!state.visible) return null;
  return <div
    className={`window-drop-overlay${state.cancelling ? ' cancelling' : ''}`}
    aria-label={t('import')}
  >
    <div className="window-drop-target">
      <div role="status">
        <h2>{t('windowDrop')}</h2>
        <p>{t('windowDropHelp')}</p>
      </div>
      <button
        className="cancel-drop-region"
        type="button"
        data-cancel-image-drop
        onClick={() => cancel.current()}
      >
        {t('cancelDrop')}
        <small>{t('cancelDropHelp')}</small>
      </button>
    </div>
  </div>;
}
