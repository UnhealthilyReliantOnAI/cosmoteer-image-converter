import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ALL_PIECE_TYPES, PIECE_CATALOG } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { STANDARD_GRID_LIMIT } from '../construction/grid';
import type { SymmetryMode } from '../construction/symmetry';
import { calculateTargetDimensions } from '../conversion/squares';
import { GridPreview } from '../rendering/GridPreview';
import { InteractivePreview } from '../rendering/InteractivePreview';
import { ConversionSession, sameSettings, toggleFamily } from './conversionSession';
import { useI18n } from './i18n';
import { ImageDropOverlay } from './ImageDropOverlay';
import { clipboardImage, isTextEditing } from './imageImportEvents';
import { ImageImportSession } from './imageImportSession';
import { ShapeIcon } from './ShapeIcon';
import { ShipExport } from './ShipExport';
import { SymmetryIcon } from './SymmetryIcon';
import { errorKey, unificationKey } from './translations';
import type { MessageKey } from './translations';

export function ImageConverter() {
  const { t, number } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [imports] = useState(() => new ImageImportSession());
  const imported = useSyncExternalStore(imports.subscribe, imports.getSnapshot, imports.getSnapshot);
  const { source, loading } = imported;
  const [size, setSize] = useState('48');
  const [session] = useState(() => new ConversionSession());
  const conversion = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const result = conversion.last?.result;
  const [families, setFamilies] = useState<readonly PieceType[]>(ALL_PIECE_TYPES);
  const converting = conversion.processing;
  const [error, setError] = useState<MessageKey | null>(null);
  const [colorMode, setColorMode] = useState<'uniform' | 'families'>('uniform');
  const [showOutlines, setShowOutlines] = useState(true);
  const [showErrors, setShowErrors] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [smoothing, setSmoothing] = useState(0);
  const [symmetry, setSymmetry] = useState<SymmetryMode>('none');
  const [forceUnified, setForceUnified] = useState(false);
  const separatedIds = useMemo(() => new Set(result?.connectivity.groups.slice(1).flatMap((group) => group.pieceIds)), [result]);
  useEffect(() => () => {
    imports.dispose();
    session.dispose();
  }, [imports, session]);
  const numericSize = Number(size);
  const validSize = size.trim() !== '' && Number.isInteger(numericSize) && numericSize >= 1 && numericSize <= STANDARD_GRID_LIMIT;
  const dimensions = source && validSize ? calculateTargetDimensions(source.mask, numericSize) : null;
  const construction = result?.construction;
  const selectedSettings = {
    largestDimension: numericSize,
    allowedFamilies: families,
    smoothing,
    symmetry,
    forceUnified,
  };
  const modified = !!conversion.last && (!validSize || !sameSettings(conversion.last.settings, selectedSettings));
  const previousSource = !!conversion.last && !!source && conversion.last.sourceId !== source.id;

  async function importImage(file: File) {
    session.replaceSource();
    setError(null);
    await imports.start(file);
  }

  function updateSize(value: string) {
    session.settingsChanged();
    setSize(value);
    setError(null);
  }

  function updateFamilies(value: readonly PieceType[]) {
    session.settingsChanged();
    setFamilies(value);
    setError(null);
  }

  function convert() {
    if (!source || !validSize || loading || families.length === 0) return;
    setError(null);
    imports.clearError();
    void session.start({ mask: source.mask, ...selectedSettings }, source);
  }

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (isTextEditing(event.target) || !event.clipboardData) return;
      const file = clipboardImage(event.clipboardData.items);
      if (!file) return;
      event.preventDefault();
      void importImage(file);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  });

  function resetSettings() {
    session.settingsChanged();
    setSize('48');
    setFamilies(ALL_PIECE_TYPES);
    setSmoothing(0);
    setSymmetry('none');
    setForceUnified(false);
    setColorMode('uniform');
    setShowOutlines(true);
    setShowGrid(true);
    setShowErrors(false);
    setShowGroups(false);
    setError(null);
  }

  return (
    <section className="workspace" aria-label={t('settings')}>
      <ImageDropOverlay
        onFile={(file) => {
          void importImage(file);
        }}
      />
      <aside className="settings-panel">
        <div className="panel-heading">
          <h2>{t('settings')}</h2>
          <button className="quiet-button" type="button" onClick={resetSettings}>{t('reset')}</button>
        </div>
        <div className="drop-zone">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="import-icon"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></svg>
          <strong>{t('drop')}</strong>
          <button type="button" onClick={() => fileInput.current?.click()}>{t('browse')}</button>
          <span>{t('paste')}</span>
          <input
            ref={fileInput}
            className="file-input"
            id="image-file"
            type="file"
            tabIndex={-1}
            aria-label={t('import')}
            aria-describedby="import-help"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importImage(file);
            }}
            onClick={(event) => {
              event.currentTarget.value = '';
            }}
          />
        </div>
        <p id="import-help" className="help">{t('importHelp')}</p>
        <p className="help">{t('convention')}</p>
        {source && <details className="source-card" open>
          <summary>
            {t('original')} <span>{source.name}</span>
          </summary>
          <img
            src={source.previewUrl}
            alt={t('originalAlt', { name: source.name })}
            onError={() => {
              if (imports.getSnapshot().source?.previewUrl === source.previewUrl) setError('previewError');
            }}
          />
          <p className="help">{source.originalWidth} × {source.originalHeight} px · {t('crop', { w: source.bounds.width, h: source.bounds.height })}</p>
          <p className="help">{t('sourceImport', { id: source.id })}</p>
        </details>}
        <div className="control-section">
          <label htmlFor="target-size">{t('size')}</label>
          <div className="size-inputs">
            <input
              id="target-size"
              type="range"
              min="1"
              max={STANDARD_GRID_LIMIT}
              step="1"
              value={validSize ? numericSize : 48}
              onChange={(event) => updateSize(event.target.value)}
            />
            <input
              aria-label={t('preciseSize')}
              type="number"
              min="1"
              max={STANDARD_GRID_LIMIT}
              step="1"
              value={size}
              onChange={(event) => updateSize(event.target.value)}
              aria-invalid={!validSize}
              aria-describedby="size-help"
            />
          </div>
          <p id="size-help" className={validSize ? 'help' : 'error-message'}>{validSize && dimensions
              ? t('dimensions', { w: dimensions.width, h: dimensions.height }) : t('sizeHelp')}</p>
        </div>
        <fieldset className="control-section">
          <legend>{t('families')}</legend>
          <div className="family-options">
            {PIECE_CATALOG.map((piece) => <button
              className="family-card"
              key={piece.type}
              type="button"
              aria-pressed={families.includes(piece.type)}
              onClick={() => updateFamilies(toggleFamily(families, piece.type))}
            >
              <ShapeIcon piece={piece} />
              <span>
                {t(piece.type)}
                <small>{t(families.includes(piece.type) ? 'selected' : 'deselected')}</small>
              </span>
              <span className="selection-mark" aria-hidden="true">{families.includes(piece.type) ? '✓' : '−'}</span>
            </button>)}
          </div>
          <div className="family-shortcuts">
            <button type="button" onClick={() => updateFamilies(['square_1x1'])}>{t('squares')}</button>
            <button type="button" onClick={() => updateFamilies(ALL_PIECE_TYPES)}>{t('all')}</button>
          </div>
          {families.length === 0 && <p className="help" role="status">{t('noFamilies')}</p>}
        </fieldset>
        <fieldset className="control-section quality-control">
          <legend>{t('quality')}</legend>
          <label htmlFor="smoothing">
            {t('smoothing')} <output>{smoothing} / 100</output>
          </label>
          <input
            id="smoothing"
            type="range"
            min="0"
            max="100"
            step="1"
            value={smoothing}
            onChange={(event) => {
              session.settingsChanged();
              setError(null);
              setSmoothing(Number(event.target.value));
            }}
            aria-describedby="smoothing-help"
          />
          <p id="smoothing-help" className="help">{t('smoothingHelp')}</p>
          <p className="help">{t('symmetry')}</p>
          <div className="symmetry-control" role="group" aria-label={t('symmetry')}>
            {(['none', 'vertical', 'horizontal'] as const).map((mode) => <button
              key={mode}
              type="button"
              aria-pressed={symmetry === mode}
              title={t(mode === 'none' ? 'none' : mode === 'vertical' ? 'verticalHelp' : 'horizontalHelp')}
              onClick={() => {
                session.settingsChanged();
                setError(null);
                setSymmetry(mode);
              }}
            >
              <SymmetryIcon mode={mode} />
              {t(mode)}
            </button>)}
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={forceUnified}
              onChange={(event) => {
                session.settingsChanged();
                setError(null);
                setForceUnified(event.target.checked);
              }}
            />
            {t('force')}
          </label>
        </fieldset>
        <div className="convert-actions">
          <button
            className="convert-button"
            type="button"
            onClick={convert}
            disabled={!source || !validSize || loading || families.length === 0}
          >{t(converting ? 'rerun' : 'convert')}</button>
          {converting && <button type="button" onClick={() => session.cancel()}>{t('cancel')}</button>}
        </div>
      </aside>
      <div className="preview-panel">
        <div className="preview-heading">
          <div>
            <p className="eyebrow">{t('tagline')}</p>
            <h2>{t('construction')}</h2>
          </div>
          {result && <span
            className={result.connectivity.groups.length === 1 ? 'connectivity unified' : 'connectivity fragmented'}
            title={t('provisional')}
          >
            {result.connectivity.groups.length === 1 ? `✓ ${t('unified')}` : result.connectivity.groups.length > 1
              ? t('fragmented', { n: result.connectivity.groups.length }) : t('noStructure')}</span>}
        </div>
        <p className="converter-status" role="status" aria-live="polite">{loading ? t('loading') : converting ? t('converting') : conversion.status === 'cancelled'
            ? t(construction ? 'cancelledPrevious' : 'cancelled') : construction
            ? t('result', { w: construction.width, h: construction.height, n: number(construction.pieces.length) }) : source ? t('ready') : t('start')}</p>
        {error && <p className="error-message alert" role="alert">{t(error)}</p>}
        {imported.error !== null && <p className="error-message alert" role="alert">
          {t(errorKey(imported.error, 'importError'))} {source && t('retainedSource')} {construction && t('retainedResult')}
        </p>}
        {conversion.status === 'error' && <p className="error-message alert" role="alert">
          {t(errorKey(conversion.error ?? '', 'conversionError'))} {construction && t('retainedResult')}
        </p>}
        {modified && <p className="previous-result" role="status">{t('modifiedParameters')}</p>}
        {previousSource && conversion.last && <p className="previous-result source-mismatch" role="status">
          {t('previousSource', { name: conversion.last.sourceName, id: conversion.last.sourceId })}
        </p>}
        <div className="preview-controls" role="group" aria-label={t('display')}>
          <label>
            {t('colors')} <select
              value={colorMode}
              onChange={(event) => setColorMode(event.target.value as 'uniform' | 'families')}
            >
              <option value="uniform">{t('uniform')}</option>
              <option value="families">{t('byFamily')}</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={showOutlines}
              onChange={(event) => setShowOutlines(event.target.checked)}
            />
            {t('outlines')}
          </label>
          <label>
            <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
            {t('grid')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={showErrors}
              onChange={(event) => setShowErrors(event.target.checked)}
            />
            {t('errors')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={showGroups}
              onChange={(event) => setShowGroups(event.target.checked)}
            />
            {t('groups')}
          </label>
        </div>
        <InteractivePreview revision={construction} busy={converting}>
          {construction ? <GridPreview
            construction={construction}
            colorMode={colorMode}
            showOutlines={showOutlines}
            showGrid={showGrid}
            pieceName={(type) => t(type)}
            mirrorLabel={t('mirrored')}
            errorsLabel={conversion.last ? t('errorsSourceAlt', { name: conversion.last.sourceName, id: conversion.last.sourceId }) : t('errorsAlt')}
            {...(showErrors && result.comparison ? { comparison: result.comparison } : {})}
            {...(showGroups ? { highlightedPieceIds: separatedIds } : {})}
            label={t('constructionAlt', { w: construction.width, h: construction.height, n: construction.pieces.length })}
          />
            : <div className="empty-preview">
            <div className="empty-grid" aria-hidden="true" />
            <h3>{t('emptyPreview')}</h3>
            <p>{t('previewHint')}</p>
          </div>}
        </InteractivePreview>
        <ShipExport
          construction={construction}
          generation={conversion.last ?? undefined}
          isCurrentGeneration={(generation) => session.getSnapshot().last === generation}
        />
        {construction && showErrors && <p className="error-legend">
          <span className="missing">{t('missing')}</span>
          <span className="excess">{t('excess')}</span>
        </p>}
        {construction && showErrors && previousSource && conversion.last && <p className="help previous-target">
          {t('previousTarget', { name: conversion.last.sourceName, id: conversion.last.sourceId })}
        </p>}
        {construction && showGroups && <p className="help">{t('groupsHelp')}</p>}
        {construction?.pieces.length === 0 && <p className="error-message" role="status">{t('emptyResult')}</p>}
        {result && <div className="result-metrics">
          <div className="metric">
            <span>{t('fidelity')}</span>
            <strong>{result.fidelity.iou === null ? t('unavailable') : `${number(result.fidelity.iou * 100, 1)} %`}</strong>
          </div>
          <div className="metric">
            <span>{t('missingArea')}</span>
            <strong>
              {number(result.fidelity.missingArea, 2)} <small>{t('cells')}</small>
            </strong>
          </div>
          <div className="metric">
            <span>{t('excessArea')}</span>
            <strong>
              {number(result.fidelity.excessArea, 2)} <small>{t('cells')}</small>
            </strong>
          </div>
          <details className="diagnostics">
            <summary>{t('detail')}</summary>
            {conversion.last && <p className="help">{t('computedWith', {
                name: conversion.last.sourceName,
                sourceId: conversion.last.sourceId,
                size: conversion.last.settings.largestDimension,
                smoothing: conversion.last.settings.smoothing ?? 0,
                symmetry: t(conversion.last.settings.symmetry ?? 'none'),
                unified: t(conversion.last.settings.forceUnified ? 'yes' : 'no'),
                families: conversion.last.settings.allowedFamilies.map((family) => t(family)).join(', '),
              })}</p>}
            <ul className="family-counts" aria-label={t('distribution')}>{PIECE_CATALOG.filter(({ type }) => result.counts[type] > 0)
              .map(({ type }) => <li key={type}>{t(type)} : {number(result.counts[type])}</li>)}</ul>
            <p className="help">{t('provisional')}</p>
            {result.optimization.localSearchLimited && <p className="help">{t('limited')}</p>}
          </details>
          {result.controls.unification.requested && !result.controls.unification.satisfied && <p className="warning" role="status">{t(unificationKey(result.controls.unification.status, result.controls.unification.message))}</p>}
        </div>}
      </div>
    </section>
  );
}
