import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { Construction } from '../construction/model';
import { ARMOR_EXPORT_ISSUE_CODES } from '../exports/shipErrors';
import type { ArmorExportIssue } from '../exports/shipErrors';
import { SHIP_EXPORT_STAGES } from '../exports/shipExportWorkerProtocol';
import { useI18n } from './i18n';
import { ShipExportSession } from './shipExportSession';
import { exportIssueKey, shipExportErrorKey, shipExportStageKey } from './translations';

function validIssue(issue: unknown): issue is ArmorExportIssue {
  return !!issue && typeof issue === 'object' && 'code' in issue && typeof issue.code === 'string'
    && ARMOR_EXPORT_ISSUE_CODES.some((code) => code === issue.code) && 'path' in issue && typeof issue.path === 'string';
}

interface ShipExportProps {
  readonly construction: Construction | undefined;
  readonly generation: object | undefined;
  readonly isCurrentGeneration: (generation: object) => boolean;
}

export function ShipExport({ construction, generation, isCurrentGeneration }: ShipExportProps) {
  const { t, number } = useI18n();
  const helpId = useId();
  const [session] = useState(() => new ShipExportSession(isCurrentGeneration));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    session.previewChanged();
  }, [session, generation]);
  useEffect(() => () => {
    session.dispose();
  }, [session]);
  const shown = state.generation === generation ? state : null;
  const running = shown?.status === 'running';
  const diagnostics = shown?.diagnostics;
  const context = shown?.error?.context;
  const required = context?.required ?? context?.containerBytes;
  const available = context?.available ?? context?.capacityBytes;
  const values = {
    required: typeof required === 'number' ? number(required) : '?',
    available: typeof available === 'number' ? number(available) : '?',
  };
  const issues = Array.isArray(context?.issues) ? context.issues.filter(validIssue) : [];
  return <div className="ship-export" aria-busy={running}>
    <div className="export-actions">
      <p id={helpId} className="help">{t(construction ? 'shipExportDisplayed' : 'exportUnavailable')}</p>
      <button
        type="button"
        className="ship-export-button"
        disabled={!construction || !generation || running}
        aria-describedby={helpId}
        onClick={() => {
          if (construction && generation) void session.start({ construction, generation });
        }}
      >{t(running ? 'shipExportWorking' : 'shipExport')}</button>
      {running && <button type="button" onClick={() => session.cancel()}>{t('shipExportCancel')}</button>}
    </div>
    {running && shown.stage && <p className="ship-export-status" role="status" aria-live="polite">
      <span className="processing-dot" aria-hidden="true" />
      {t('shipExportProgress', {
        step: SHIP_EXPORT_STAGES.indexOf(shown.stage) + 1,
        total: SHIP_EXPORT_STAGES.length,
        stage: t(shipExportStageKey(shown.stage)),
      })}
    </p>}
    {shown?.status === 'cancelled' && <p className="help" role="status">{t('shipExportCancelled')}</p>}
    {state.status === 'stale' && <p className="help" role="status">{t('shipExportStale')}</p>}
    {shown?.error && <div className="error-message" role="alert">
      <p>{t(shipExportErrorKey(shown.error.code), values)}
        {shown.error.code !== 'E_DOWNLOAD' && <span className="export-error-code"> ({shown.error.code})</span>}
      </p>
      {issues.length > 0 && <ul>{issues.map(({ code, path }, index) =>
        <li key={index}>{t(exportIssueKey(code))} ({path})</li>)}</ul>}
    </div>}
    {shown?.status === 'ready' && diagnostics && <div className="ship-export-ready">
      <div className="export-actions">
        <p className="help" role="status">{t('shipExportReady', { n: number(diagnostics.partsCount) })}</p>
        <button type="button" className="quiet-button" onClick={() => session.downloadReady()}>{t('shipExportDownloadReady')}</button>
      </div>
      {diagnostics.thumbnailMode === 'neutral' && <p className="warning" role="status">{t('shipExportNeutral')}</p>}
    </div>}
  </div>;
}
